/**
 * Admin storage configuration — GET/PUT the driver + S3 settings and a
 * "Test connection" probe, so an operator can point Zveltio at their own
 * SeaweedFS/S3 (or stay on the local driver) from the Studio instead of editing
 * env files. Config is persisted in zv_settings (`storage_config`) and layered
 * over env via setStorageOverlay; secrets are never returned in GET.
 */

import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { checkPermission } from '../../lib/tenancy/index.js';
import { setStorageOverlay, storageConfig } from '../../lib/storage/index.js';
import { probeLocal, probeS3 } from '../../lib/storage/probe.js';

const SETTINGS_KEY = 'storage_config';

// biome-ignore lint/suspicious/noExplicitAny: request-shaped input
function normalizeOverlay(body: any) {
  const s3 = body?.s3 ?? {};
  return {
    driver: typeof body?.driver === 'string' ? body.driver : undefined,
    localDir: typeof body?.localDir === 'string' ? body.localDir : undefined,
    s3: {
      endpoint: typeof s3.endpoint === 'string' ? s3.endpoint : undefined,
      accessKey: typeof s3.accessKey === 'string' ? s3.accessKey : undefined,
      secretKey: typeof s3.secretKey === 'string' ? s3.secretKey : undefined,
      region: typeof s3.region === 'string' ? s3.region : undefined,
      bucket: typeof s3.bucket === 'string' ? s3.bucket : undefined,
      publicUrl: typeof s3.publicUrl === 'string' ? s3.publicUrl : undefined,
    },
  };
}

export function registerStorageAdminRoutes(app: Hono, db: Database): void {
  // GET /api/admin/storage/config — current effective config, secrets masked.
  app.get('/storage/config', async (c) => {
    const cfg = storageConfig();
    return c.json({
      driver: cfg.driver,
      localDir: cfg.localDir,
      s3: {
        endpoint: cfg.s3.endpoint,
        bucket: cfg.s3.bucket,
        region: cfg.s3.region,
        publicUrl: cfg.s3.publicUrl,
        accessKey: cfg.s3.accessKey,
        // Never leak the secret; just report whether one is configured.
        secretKeySet: Boolean(cfg.s3.secretKey),
      },
    });
  });

  // PUT /api/admin/storage/config — persist + apply the overlay (admin only).
  app.put('/storage/config', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: session user
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) return c.json({ error: 'Forbidden' }, 403);

    const overlay = normalizeOverlay(await c.req.json().catch(() => ({})));
    await db
      .insertInto('zv_settings')
      .values({
        key: SETTINGS_KEY,
        value: JSON.stringify(overlay),
        is_public: false,
        updated_at: new Date(),
      })
      // biome-ignore lint/suspicious/noExplicitAny: kysely onConflict
      .onConflict((oc: any) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(overlay), updated_at: new Date() }),
      )
      .execute();
    setStorageOverlay(overlay);
    return c.json({ ok: true, driver: storageConfig().driver });
  });

  // POST /api/admin/storage/test — probe the GIVEN (or current) config.
  app.post('/storage/test', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: session user
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) return c.json({ error: 'Forbidden' }, 403);

    const body = normalizeOverlay(await c.req.json().catch(() => ({})));
    const cur = storageConfig();
    const driver = body.driver || cur.driver;
    const result =
      driver === 's3'
        ? await probeS3({
            endpoint: body.s3.endpoint ?? cur.s3.endpoint,
            accessKey: body.s3.accessKey ?? cur.s3.accessKey,
            secretKey: body.s3.secretKey ?? cur.s3.secretKey,
            region: body.s3.region ?? cur.s3.region,
            bucket: body.s3.bucket ?? cur.s3.bucket,
            publicUrl: body.s3.publicUrl ?? cur.s3.publicUrl,
          })
        : await probeLocal(body.localDir ?? cur.localDir);
    // Always 200: the probe RAN; its verdict (ok/detail) is the payload. A failed
    // connection is not an HTTP error (and a 4xx would be rewritten by the
    // problem+json normalizer, dropping {ok, detail}).
    return c.json({ driver, ...result });
  });
}

/**
 * Load persisted storage settings from zv_settings into the config overlay at
 * boot. Call after the DB is ready. Failures are non-fatal (env-only config).
 */
export async function loadStorageSettings(db: Database): Promise<void> {
  try {
    const row = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', SETTINGS_KEY)
      .executeTakeFirst();
    if (!row) return;
    const raw = (row as { value: unknown }).value;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') setStorageOverlay(parsed);
  } catch (err) {
    console.warn('[storage] failed to load storage_config from settings:', (err as Error).message);
  }
}

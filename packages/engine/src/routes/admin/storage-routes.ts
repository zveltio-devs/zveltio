/**
 * Admin storage configuration — GET/PUT the driver + S3 settings and a
 * "Test connection" probe, so an operator can point Zveltio at their own
 * SeaweedFS/S3 (or stay on the local driver) from the Studio instead of editing
 * env files. Config is persisted in zv_settings (`storage_config`) and layered
 * over env via setStorageOverlay; secrets are never returned in GET.
 */

import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { isGodUser, requireInstanceAdmin } from '../../lib/tenancy/index.js';
import { requireStepUp } from '../../lib/step-up.js';
import { toNumber } from '../../lib/numeric.js';
import { decryptField, encryptField, isEncryptedValue } from '../../lib/data/index.js';
import { auditLog } from '../../lib/audit.js';
import { clientIpForAudit, validateStorageEndpoint } from '../../lib/security/index.js';
import { probeLocal, probeS3, setStorageOverlay, storageConfig } from '../../lib/storage/index.js';
import { DEFAULT_QUOTA_BYTES } from '../../lib/storage-quota.js';

const SETTINGS_KEY = 'storage_config';

type Overlay = ReturnType<typeof normalizeOverlay>;

/** Encrypt the S3 secret before it is persisted (AES-256-GCM, `enc1:` — the same
 * at-rest treatment as mail/AI provider keys). Idempotent + no-op when empty. */
async function withEncryptedSecret(o: Overlay): Promise<Overlay> {
  const sk = o.s3.secretKey;
  if (!sk || isEncryptedValue(sk)) return o;
  return { ...o, s3: { ...o.s3, secretKey: await encryptField(sk) } };
}

/** Decrypt the persisted S3 secret back to plaintext for the in-memory driver. */
async function withDecryptedSecret(o: Overlay): Promise<Overlay> {
  const sk = o.s3?.secretKey;
  if (!sk || !isEncryptedValue(sk)) return o;
  return { ...o, s3: { ...o.s3, secretKey: await decryptField(sk) } };
}

function normalizeOverlay(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const s3 = (b.s3 ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    driver: str(b.driver),
    localDir: str(b.localDir),
    s3: {
      endpoint: str(s3.endpoint),
      accessKey: str(s3.accessKey),
      secretKey: str(s3.secretKey),
      region: str(s3.region),
      bucket: str(s3.bucket),
      publicUrl: str(s3.publicUrl),
    },
  };
}

export function registerStorageAdminRoutes(app: Hono, db: Database): void {
  /**
   * PUT /api/admin/storage-quotas/:userId — `{ quota_bytes }`: a user's storage
   * quota (lib/storage-quota.ts), a whole number of bytes, or null for the
   * default. `zv_storage_quotas` is keyed by user with no tenant, so a quota
   * binds the user in every firm: god only, confirmed by a step-up for this
   * user (as the extension installs are), and audited with the value it replaced.
   */
  app.put('/storage-quotas/:userId', async (c) => {
    const actor = c.get('user') as { id: string };
    if (!(await isGodUser(actor.id))) return c.json({ error: 'Forbidden' }, 403);
    const body = (await c.req.json().catch(() => null)) as { quota_bytes?: unknown } | null;
    const quotaBytes = body?.quota_bytes;
    if (
      quotaBytes !== null &&
      (typeof quotaBytes !== 'number' || !Number.isSafeInteger(quotaBytes) || quotaBytes < 0)
    ) {
      return c.json(
        { error: 'quota_bytes must be a whole number of bytes, 0 or more, or null' },
        400,
      );
    }
    const userId = c.req.param('userId');
    const confirmedBy = await requireStepUp(c, `storage.quota:${userId}`);
    if (confirmedBy instanceof Response) return confirmedBy;
    const target = await db
      .selectFrom('user')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!target) return c.json({ error: 'User not found' }, 404);

    const prev = await db
      .selectFrom('zv_storage_quotas')
      .select('quota_bytes')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (quotaBytes === null) {
      await db.deleteFrom('zv_storage_quotas').where('user_id', '=', userId).execute();
    } else {
      await db
        .insertInto('zv_storage_quotas')
        .values({ user_id: userId, quota_bytes: quotaBytes, used_bytes: 0 })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({ quota_bytes: quotaBytes, updated_at: new Date() }),
        )
        .execute();
    }
    await auditLog(db, {
      type: 'storage.quota_changed',
      tenantId: null,
      userId: actor.id,
      resourceType: 'storage_quota',
      resourceId: userId,
      metadata: {
        quota_bytes: quotaBytes,
        previous: prev ? toNumber(prev.quota_bytes, 0, 'quota_bytes') : null,
        confirmed_by: confirmedBy,
      },
      ip: clientIpForAudit(c) ?? undefined,
    });
    return c.json({ user_id: userId, quota_bytes: quotaBytes ?? DEFAULT_QUOTA_BYTES });
  });

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
    const user = c.get('user');
    if (!(await requireInstanceAdmin(user.id))) return c.json({ error: 'Forbidden' }, 403);

    const overlay = normalizeOverlay(await c.req.json().catch(() => ({})));
    // The driver signs every upload to this endpoint, so the metadata refusal
    // the "Test connection" probe applies must hold for the saved value too.
    if (overlay.s3.endpoint) {
      try {
        validateStorageEndpoint(overlay.s3.endpoint);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    const persisted = JSON.stringify(await withEncryptedSecret(overlay));
    await db
      .insertInto('zv_settings')
      .values({ key: SETTINGS_KEY, value: persisted, is_public: false, updated_at: new Date() })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: persisted, updated_at: new Date() }),
      )
      .execute();
    // The in-memory overlay keeps the plaintext secret so the driver can auth.
    setStorageOverlay(overlay);
    // The keys that changed, never their values: the overlay carries a secret
    // and this row is readable by anyone who can read the audit trail.
    await auditLog(db, {
      type: 'settings.changed',
      tenantId: null,
      userId: user?.id,
      resourceType: 'storage_config',
      metadata: { driver: storageConfig().driver, fields: Object.keys(overlay).sort() },
    });

    return c.json({ ok: true, driver: storageConfig().driver });
  });

  // POST /api/admin/storage/test — probe the GIVEN (or current) config.
  app.post('/storage/test', async (c) => {
    const user = c.get('user');
    if (!(await requireInstanceAdmin(user.id))) return c.json({ error: 'Forbidden' }, 403);

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
    if (parsed && typeof parsed === 'object') {
      setStorageOverlay(await withDecryptedSecret(parsed as Overlay));
    }
  } catch (err) {
    console.warn('[storage] failed to load storage_config from settings:', (err as Error).message);
  }
}

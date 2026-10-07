/**
 * `ctx.internals.asSystem` audits who asked for it. A request authenticated by
 * an API key has no `"user"` row: `zveltio.user_id` is `apikey:<id>`, and
 * writing that into `zv_audit_log.user_id` failed its foreign key, so the row
 * was lost and a key's system write left no trail at all. The key is recorded
 * in the metadata.
 *
 * The extension runs behind the engine's own `/ext/*` chain (prefetch, tenant
 * transaction, auth gate), as `index.ts` mounts it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `asak_${STAMP}`;
const EXT = `asak-ext-${STAMP}`;
const REASON = `audit-probe-${STAMP}`;

d('asSystem names the API key that asked for it', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godCookie = '';
  let keyId = '';
  let rawKey = '';

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    godCookie = await createGodSession(engine, db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, ctx) {
        sub.post('/sys', async (c) => {
          await ctx.internals.asSystem([C], async () => 1, { reason: REASON });
          return c.json({ ok: true });
        });
      },
    };
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      app,
      ctx,
      {
        name: EXT,
        version: '1.0.0',
        category: 'custom',
        permissions: ['data:system'],
        apiKeyRoutes: ['POST /sys'],
      } as never,
      new Set(['data:system']),
    );
    invalidateActivationCache();

    const res = await engine.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie: godCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `asak-${STAMP}`,
        scopes: [{ collection: `$ext:${EXT}`, actions: ['create'] }],
      }),
    });
    const body = (await res.json()) as { id: string; key: string };
    keyId = body.id;
    rawKey = body.key;
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    if (keyId) await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await dropTestCollection(db, C);
  });

  it('writes the row, naming the key', async () => {
    const res = await app.request(`/ext/${EXT}/sys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
      body: '{}',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    await _settleAuditWrites();
    const rows = await sql<{ user_id: string | null; api_key: string | null }>`
      SELECT user_id, metadata->>'api_key' AS api_key FROM zv_audit_log
       WHERE event_type = 'extension.as_system' AND metadata->>'reason' = ${REASON}`.execute(db);
    expect(rows.rows).toEqual([{ user_id: null, api_key: `apikey:${keyId}` }]);
  });
});

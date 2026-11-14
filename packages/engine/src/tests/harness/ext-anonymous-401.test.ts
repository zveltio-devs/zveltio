/**
 * ADR 0047 decision 3: an anonymous `/ext/` path answers 401, installed or not.
 *
 * A 404 for an extension that is not there next to a 401 for one that is would
 * list a firm's modules to anyone, which `GET /api/extensions` hides on purpose.
 * The gate already refused an absent extension and an installed one's undeclared
 * path alike; the gap was a declared public route of an extension the firm turned
 * off: the gate let it through as public and the sub-app answered 404. Off for
 * the firm, it is not a public route there: 401 anonymous, 404 signed in, as an
 * absent extension is. Its public routes still serve where it is on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const EXT = `anon401-${String(Date.now()).slice(-7)}`;

d('anonymous /ext/ answers 401, installed or not (ADR 0047 d3)', () => {
  let db: Database;
  let app: Hono;
  let member = '';

  const get = (path: string, cookie?: string) =>
    app.request(path, { headers: cookie ? { cookie } : {} });

  /** Turn the extension off (or back on) for tenant A, over the global row. */
  const offForTenant = async (off: boolean) => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT} AND tenant_id = ${TENANT_A}`.execute(
      db,
    );
    if (off) {
      await sql`
        INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${EXT}, ${EXT}, ${TENANT_A}, true, false)
      `.execute(db);
    }
    invalidateActivationCache();
  };

  beforeAll(async () => {
    let engine: Hono;
    ({ app: engine, db } = await getTestApp());
    member = (await createMemberSession(engine, db, {})).cookie;

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(r) {
        (r as Hono).get('/pub/hello', (c) => c.json({ ok: true }));
        (r as Hono).get('/priv/hello', (c) => c.json({ ok: true }));
      },
    };
    const parsed = ManifestSchema.parse({ name: EXT, publicRoutes: ['/pub/*'] });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${EXT}, ${EXT}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
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
      parsed as never,
      new Set(),
    );
    // index.ts: what no mounted extension answers.
    app.all('/ext/*', (c) => c.json({ error: 'Not found' }, 404));
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (db) await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
  });

  it('an absent extension and an undeclared path: 401 anonymous, 404 / 200 signed in', async () => {
    expect((await get('/ext/no-such-ext-anon401/x')).status).toBe(401);
    expect((await get(`/ext/${EXT}/priv/hello`)).status).toBe(401);
    expect((await get('/ext/no-such-ext-anon401/x', member)).status).toBe(404);
    expect((await get(`/ext/${EXT}/priv/hello`, member)).status).toBe(200);
  });

  it('a public route serves anonymously where the extension is on', async () => {
    await offForTenant(false);
    expect((await get(`/ext/${EXT}/pub/hello`)).status).toBe(200);
  });

  it('turned off for the firm, its public route answers as an absent extension does', async () => {
    await offForTenant(true);
    try {
      expect((await get(`/ext/${EXT}/pub/hello`)).status).toBe(401);
      expect((await get('/ext/no-such-ext-anon401/pub/hello')).status).toBe(401);
      expect((await get(`/ext/${EXT}/pub/hello`, member)).status).toBe(404);
    } finally {
      await offForTenant(false);
    }
  });
});

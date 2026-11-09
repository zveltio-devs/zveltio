/**
 * `GET /api/actions` (ADR 0029): the actions a caller may run, with their input
 * JSON Schema — and only those. For every caller here, the list agrees with what
 * `POST /ext/<ext>/actions/<name>` answers that caller: listed ⇔ 200.
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
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const RES = `apiact_res_${STAMP}`;
const EXT = `apiact-ext-${STAMP}`;
const PING_INPUT = { type: 'object', properties: { n: { type: 'number' } } };
const NAMES = ['ping', 'approve'] as const;

type Creds = Record<string, string>;

d('GET /api/actions lists exactly the actions the caller may run', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  const keys: string[] = [];

  const listed = async (creds: Creds) => {
    const res = await engine.request('/api/actions', { headers: creds });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actions: { extension: string; name: string; input: unknown }[];
    };
    return body.actions.filter((a) => a.extension === EXT);
  };
  const runs = async (name: string, creds: Creds) =>
    (
      await app.request(`/ext/${EXT}/actions/${name}`, {
        method: 'POST',
        headers: { ...creds, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status === 200;
  /** The list, and the proof it is the route's answer: listed ⇔ the action runs. */
  const agree = async (creds: Creds) => {
    const names = (await listed(creds)).map((a) => a.name);
    for (const n of NAMES) expect([n, names.includes(n)]).toEqual([n, await runs(n, creds)]);
    return names;
  };
  const keyFor = async (issuer: string, scopes: unknown) => {
    const raw = generateApiKey();
    const row = await sql<{ id: string }>`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, created_by, is_active, tenant_id)
      VALUES ('apiact', ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify(scopes)}::jsonb, ${issuer}, true, ${DEFAULT_TENANT_ID})
      RETURNING id
    `.execute(db);
    keys.push(row.rows[0]!.id);
    return { 'x-api-key': raw };
  };
  const grant = async (userId: string, action: string, on: boolean) => {
    const e = await getEnforcer();
    await (on ? e.addPolicy(userId, '*', RES, action) : e.removePolicy(userId, '*', RES, action));
    await invalidateUserPermCache(userId);
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      actions: { ping: async () => 'pong', approve: async () => 'approved' },
      async register() {},
    };
    const manifest = ManifestSchema.parse({
      name: EXT,
      resources: [RES],
      actions: [
        { name: 'ping', permission: { resource: RES }, input: PING_INPUT },
        { name: 'approve', permission: { resource: RES, action: 'approve' }, input: {} },
      ],
    });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${EXT}, ${EXT}, NULL, true, true, ${toJsonb(manifest)})
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map([[EXT, ext]]),
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
      manifest as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    for (const id of keys) await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${RES}`.execute(db);
  });

  it('refuses an anonymous caller 401', async () => {
    expect((await engine.request('/api/actions')).status).toBe(401);
  });

  it('a session sees the actions its permission opens, with their input schema', async () => {
    const member = await createMemberSession(engine, db, {});
    const creds = { cookie: member.cookie };
    expect(await agree(creds)).toEqual([]);
    await grant(member.userId, 'execute', true);
    expect(await agree(creds)).toEqual(['ping']);
    expect(await listed(creds)).toEqual([{ extension: EXT, name: 'ping', input: PING_INPUT }]);
  });

  it('a key sees an action only with $ext:<name> for it AND its issuer’s permission', async () => {
    const issuer = await createMemberSession(engine, db, {});
    await grant(issuer.userId, 'execute', true);
    await grant(issuer.userId, 'approve', true);
    const execute = await keyFor(issuer.userId, [
      { collection: `$ext:${EXT}`, actions: ['execute'] },
    ]);
    const all = await keyFor(issuer.userId, [{ collection: `$ext:${EXT}`, actions: ['*'] }]);
    const none = await keyFor(issuer.userId, [{ collection: '*', actions: ['*'] }]);
    expect(await agree(execute)).toEqual(['ping']);
    expect(await agree(all)).toEqual(['ping', 'approve']);
    expect(await agree(none)).toEqual([]);

    // The issuer loses `execute`: so do their keys, in the list as on the route.
    await grant(issuer.userId, 'execute', false);
    expect(await agree(execute)).toEqual([]);
    expect(await agree(all)).toEqual(['approve']);
  });

  it('an extension switched off for the caller’s tenant lists nothing, as its route answers', async () => {
    const member = await createMemberSession(engine, db, {});
    const creds = { cookie: member.cookie };
    await grant(member.userId, 'execute', true);
    expect(await agree(creds)).toEqual(['ping']);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, ${DEFAULT_TENANT_ID}, true, false)
    `.execute(db);
    invalidateActivationCache();
    try {
      expect(await agree(creds)).toEqual([]);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT} AND tenant_id IS NOT NULL`.execute(
        db,
      );
      invalidateActivationCache();
    }
  });

  it('an unknown key is 401', async () => {
    expect(
      (await engine.request('/api/actions', { headers: { 'x-api-key': 'zv_nope' } })).status,
    ).toBe(401);
  });
});

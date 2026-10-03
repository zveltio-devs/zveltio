/**
 * `ctx.internals.createRecord` / `updateRecord` / `deleteRecord`: an extension
 * writes a collection record through the data API's own handlers, AS the caller
 * the `/ext/*` gate admitted — and there is no way to make it anyone else.
 *
 * `developer/graphql` wrote with Kysely through `ctx.db` until these existed, so
 * its mutations skipped alters, entity access for update/delete, `created_by`,
 * revisions, webhooks, flows and realtime, and ran hooks as the extension (its
 * own suite, `engine-gate.test.ts`, pins that). This one pins the identity: it
 * comes from the gate, never from anything the extension holds or passes.
 *
 * The extension is registered by the engine's own loader behind the engine's
 * own `/ext/*` chain (prefetch, tenant transaction, auth gate), as `index.ts`
 * mounts it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext, ExtensionInternals } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `wac_${STAMP}`;
const WRITER = `wac-writer-${STAMP}`;
const NOCAP = `wac-nocap-${STAMP}`;

d('an extension writes records as the request caller, and only as them', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godId = '';
  let godCookie = '';
  let member: { cookie: string; userId: string };
  let internals: ExtensionInternals;
  let kept: Context | undefined;
  const keys: string[] = [];

  /** Mount `ext` through the real loader behind the real `/ext/*` chain. */
  async function load(ext: ZveltioExtension, manifest: Record<string, unknown>): Promise<void> {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true)
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
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      { name: ext.name, version: '1.0.0', category: 'custom', ...manifest } as never,
      new Set(),
    );
  }

  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const authorOf = async (label: string) =>
    (
      await sql<{ id: string; created_by: string | null }>`
        SELECT id, created_by FROM ${sql.table(`zvd_${C}`)} WHERE label = ${label}
      `.execute(db)
    ).rows[0];
  const revisionAuthor = async (id: string) =>
    (
      await sql<{ user_id: string | null }>`
        SELECT user_id FROM zv_revisions WHERE collection = ${C} AND record_id = ${id}
      `.execute(db)
    ).rows.map((r) => r.user_id);

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    godCookie = await createGodSession(engine, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ t: string | null }>`SELECT to_regclass(${`zvd_${C}`}) AS t`.execute(
        db,
      );
      if (seen.rows[0]?.t) break;
      await Bun.sleep(100);
    }
    member = await createMemberSession(engine, db, {
      grants: [{ collection: C, actions: ['read', 'create', 'update'] }],
    });

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    // `index.ts` hands the gate the same instance; its narrow type is `getSession` alone.
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    await load(
      {
        name: WRITER,
        category: 'custom',
        mountStrategy: 'subapp',
        async register(sub, ctx) {
          internals = ctx.internals as unknown as ExtensionInternals;
          sub.post('/write', async (c) => {
            const { label, forge } = await c.req.json();
            if (forge) {
              // Everything an extension holding `c` could try: overwrite the
              // user, rewrite the object the gate put there, pass one more argument.
              const seen = c.get('user') as { id: string };
              c.set('user', { id: forge, name: 'forged', role: 'god' } as never);
              seen.id = forge;
            }
            const res = await (
              internals.createRecord as (
                ...a: unknown[]
              ) => ReturnType<typeof internals.createRecord>
            )(c, C, { label }, { user: { id: forge, role: 'god' }, authType: 'session' });
            return c.json(res.body, res.status as 201);
          });
          sub.post('/update', async (c) => {
            const { id, label } = await c.req.json();
            const res = await internals.updateRecord(c, C, id, { label });
            return c.json(res.body, res.status as 200);
          });
          sub.post('/keep', (c) => {
            kept = c as unknown as Context;
            return c.json({ kept: true });
          });
          sub.post('/write-with-foreign', async (c) => {
            // A context that is not this request's, passed while this request
            // runs: the gate's scope is live, but it belongs to `c`, not to them.
            const forged = {
              get: () => ({ id: godId, role: 'god' }),
              req: {},
              json: () => undefined,
            };
            const refused: string[] = [];
            for (const [name, other] of [
              ['kept', kept],
              ['forged', forged],
            ] as const) {
              try {
                await internals.createRecord(other, C, { label: `foreign-${name}` });
              } catch {
                refused.push(name);
              }
            }
            return c.json({ refused });
          });
        },
      },
      { permissions: ['data:write'], apiKeyRoutes: ['POST /write'] },
    );
    await load(
      {
        name: NOCAP,
        category: 'custom',
        mountStrategy: 'subapp',
        async register(sub, ctx) {
          sub.post('/write', async (c) => {
            try {
              await ctx.internals.createRecord(c, C, { label: 'nocap' });
              return c.json({ wrote: true });
            } catch (err) {
              return c.json({ refused: (err as Error).name });
            }
          });
        },
      },
      { permissions: [] },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    for (const id of keys) await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${WRITER}, ${NOCAP})`.execute(db);
    await sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(db);
    await dropTestCollection(db, C);
  });

  it('writes as the session caller, with a revision as that caller', async () => {
    const res = await post(
      `/ext/${WRITER}/write`,
      { label: 'by-member' },
      { cookie: member.cookie },
    );
    expect(res.status).toBe(201);
    const row = await authorOf('by-member');
    expect(row?.created_by).toBe(member.userId);
    expect(await revisionAuthor(row!.id)).toEqual([member.userId]);
  });

  it('cannot be made to write as someone else', async () => {
    const res = await post(
      `/ext/${WRITER}/write`,
      { label: 'forged', forge: godId },
      { cookie: member.cookie },
    );
    expect(res.status).toBe(201);
    const row = await authorOf('forged');
    expect(row?.created_by).toBe(member.userId);
    expect(await revisionAuthor(row!.id)).toEqual([member.userId]);
  });

  it('refuses outside the request the context belongs to — there is no default caller', async () => {
    expect((await post(`/ext/${WRITER}/keep`, {}, { cookie: godCookie })).status).toBe(200);
    expect(kept).toBeDefined();
    // A context kept from a finished request, and an object shaped like one.
    const forged = { get: () => ({ id: godId, role: 'god' }), req: {}, json: () => undefined };
    for (const c of [kept, forged, undefined]) {
      await expect(internals.createRecord(c, C, { label: 'outside' })).rejects.toThrow(
        'pass the request context',
      );
    }
    expect(await authorOf('outside')).toBeUndefined();
  });

  it('refuses a context other than the running request’s, even while one runs', async () => {
    expect((await post(`/ext/${WRITER}/keep`, {}, { cookie: godCookie })).status).toBe(200);
    const res = await post(`/ext/${WRITER}/write-with-foreign`, {}, { cookie: member.cookie });
    expect(await res.json()).toEqual({ refused: ['kept', 'forged'] });
    expect(await authorOf('foreign-kept')).toBeUndefined();
    expect(await authorOf('foreign-forged')).toBeUndefined();
  });

  it('an API key writes with its scopes, attributed to whoever issued it', async () => {
    const mint = async (scopes: unknown) => {
      const res = await engine.request('/api/admin/api-keys', {
        method: 'POST',
        headers: { cookie: godCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `wac-${keys.length}`, scopes }),
      });
      const body = (await res.json()) as { id: string; key: string };
      keys.push(body.id);
      return body.key;
    };
    const route = { collection: `$ext:${WRITER}`, actions: ['create'] };
    const full = await mint([route, { collection: C, actions: ['create'] }]);
    const routeOnly = await mint([route]);

    const ok = await post(`/ext/${WRITER}/write`, { label: 'by-key' }, { 'x-api-key': full });
    expect(ok.status).toBe(201);
    const row = await authorOf('by-key');
    expect(row?.created_by).toBe(godId);
    expect(await revisionAuthor(row!.id)).toEqual([godId]);

    // Admitted to the route, but the key does not reach the collection.
    const refused = await post(
      `/ext/${WRITER}/write`,
      { label: 'key-no-scope' },
      {
        'x-api-key': routeOnly,
      },
    );
    expect(refused.status).toBe(403);
    expect(await authorOf('key-no-scope')).toBeUndefined();
  });

  it('hands an entity rule the caller’s role, as a REST write does', async () => {
    // The gate copied the session user as better-auth returned it — no role —
    // while `authenticate` gives a REST caller theirs.
    const seen: Array<string | undefined> = [];
    entityAccessRegistry.registerAs(WRITER, `zvd_${C}`, (_r: unknown, u: { role?: string }) => {
      seen.push(u.role);
      return u.role === 'member' ? 'allow' : 'deny';
    });
    try {
      expect(
        (await post(`/ext/${WRITER}/write`, { label: 'role-u' }, { cookie: member.cookie })).status,
      ).toBe(201);
      const row = await authorOf('role-u');
      const res = await post(
        `/ext/${WRITER}/update`,
        { id: row!.id, label: 'role-u2' },
        { cookie: member.cookie },
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual(['member']);
    } finally {
      entityAccessRegistry.unregisterAll(WRITER);
    }
  });

  it('is refused to an extension whose manifest does not declare data:write', async () => {
    const res = await post(`/ext/${NOCAP}/write`, {}, { cookie: member.cookie });
    expect(await res.json()).toEqual({ refused: 'CapabilityDeniedError' });
    expect(await authorOf('nocap')).toBeUndefined();
  });
});

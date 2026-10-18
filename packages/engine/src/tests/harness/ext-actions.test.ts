/**
 * Extension actions (RFC v3 "Actions"): `POST /ext/<name>/actions/<action>`.
 *
 * The engine owns everything around the function: the caller's Casbin check on
 * the declared permission, the JSON Schema input, the declared collections, the
 * request transaction the action runs in, and one audit row per run. The
 * extension is loaded by the engine's own loader behind the engine's own
 * `/ext/*` chain (prefetch, tenant transaction, auth gate), as `index.ts`
 * mounts it — the transaction and the identity are the real ones.
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
import { DDLManager } from '../../lib/data/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/permissions.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `act_${STAMP}`;
const RES = `act_res_${STAMP}`;
const EXT = `act-ext-${STAMP}`;
const NOCAP = `act-nocap-${STAMP}`;
const REFUSED = `act-refused-${STAMP}`;
const NOTRX = `act-notrx-${STAMP}`;
const SENS = `act_sens_${STAMP}`;
const SENSEXT = `act-sens-${STAMP}`;

const labelInput = {
  type: 'object',
  properties: { label: { type: 'string', minLength: 1 } },
  required: ['label'],
  additionalProperties: false,
};

d('extension actions run as the caller, in the request transaction', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  let outsider: { cookie: string; userId: string };
  /** Only the seeded tenant roles: no per-user grant on the data or the resource. */
  let tenantMember: { cookie: string; userId: string };
  let tenantViewer: { cookie: string; userId: string };

  function loader(ctx: ExtensionContext): ExtensionLoader {
    return {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
  }

  /** Mount `ext` through the real loader behind the real `/ext/*` chain. */
  async function load(
    ext: ZveltioExtension,
    manifest: Record<string, unknown>,
    target = app,
  ): Promise<void> {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true)
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      target,
      ctx,
      ManifestSchema.parse({ name: ext.name, ...manifest }) as never,
      new Set(),
    );
  }

  const act = (ext: string, name: string, body: unknown, cookie: string) =>
    app.request(`/ext/${ext}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const rowsLabelled = async (label: string) =>
    (
      await sql<{ id: string; created_by: string | null }>`
        SELECT id, created_by FROM ${sql.table(`zvd_${C}`)} WHERE label = ${label}
      `.execute(db)
    ).rows;
  const auditRows = async (action: string) => {
    await _settleAuditWrites();
    return (
      await sql<{ user_id: string | null; metadata: Record<string, unknown> }>`
        SELECT user_id, metadata FROM zv_audit_log
        WHERE event_type = 'extension.action.executed' AND resource_id = ${`${EXT}:${action}`}
        ORDER BY created_at
      `.execute(db)
    ).rows;
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
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
    const dataGrant = { collection: C, actions: ['read', 'create'] };
    member = await createMemberSession(engine, db, {
      grants: [dataGrant, { collection: RES, actions: ['execute'] }],
    });
    // Everything on the data, nothing on the action's resource.
    outsider = await createMemberSession(engine, db, { grants: [dataGrant] });
    tenantMember = await createMemberSession(engine, db);
    tenantViewer = await createMemberSession(engine, db);
    const e = await getEnforcer();
    await e.addRoleForUser(tenantMember.userId, 'tenant_member', DEFAULT_TENANT_ID);
    await e.addRoleForUser(tenantViewer.userId, 'tenant_viewer', DEFAULT_TENANT_ID);
    await invalidateAllPermissionCaches();

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          addItem: async (input, host) => {
            const rec = await host.collections.insert(C, input as Record<string, unknown>);
            return host.collections.read(C, String(rec.id));
          },
          addThenThrow: async (input, host) => {
            await host.collections.insert(C, input as Record<string, unknown>);
            throw new Error('the action failed after writing');
          },
          sneak: async (input, host) =>
            (input as { mode: string }).mode === 'read'
              ? host.collections.list(C)
              : host.collections.insert(C, { label: 'sneaked' }),
        },
        async register(sub) {
          // An extension's own catch-all: it answers every route it is mounted ahead of.
          sub.use('*', async (c) => c.json({ intercepted: true }, 418));
          sub.get('/ping', (c) => c.json({ ok: true }));
        },
      },
      {
        permissions: ['data:write'],
        resources: [RES],
        actions: [
          {
            name: 'addItem',
            permission: { resource: RES },
            input: labelInput,
            reads: [C],
            writes: [C],
          },
          { name: 'addThenThrow', permission: { resource: RES }, input: labelInput, writes: [C] },
          {
            name: 'sneak',
            permission: { resource: RES },
            input: { type: 'object', properties: { mode: { enum: ['read', 'write'] } } },
          },
        ],
      },
    );
    await load(
      {
        name: NOCAP,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          addItem: (input, host) => host.collections.insert(C, input as Record<string, unknown>),
        },
        async register() {},
      },
      {
        resources: [RES],
        actions: [
          { name: 'addItem', permission: { resource: RES }, input: labelInput, writes: [C] },
        ],
      },
    );
    await load(
      {
        name: SENSEXT,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: { go: async () => 'ran' },
        async register() {},
      },
      {
        resources: [SENS],
        sensitiveResources: [SENS],
        actions: [{ name: 'go', permission: { resource: SENS }, input: { type: 'object' } }],
      },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${NOCAP}, ${REFUSED}, ${NOTRX}, ${SENSEXT})`.execute(
      db,
    );
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${RES}, ${SENS})`.execute(db);
    await sql`DELETE FROM zv_audit_log WHERE event_type = 'extension.action.executed'`.execute(db);
    await sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(db);
    await dropTestCollection(db, C);
  });

  it('runs as the caller and answers its result', async () => {
    const res = await act(EXT, 'addItem', { label: 'by-member' }, member.cookie);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { id: string; label: string } };
    expect(result.label).toBe('by-member');
    const rows = await rowsLabelled('by-member');
    expect(rows).toEqual([{ id: result.id, created_by: member.userId }]);
  });

  it('refuses a caller without the declared permission, before running anything', async () => {
    const res = await act(EXT, 'addItem', { label: 'by-outsider' }, outsider.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_required');
    expect(await rowsLabelled('by-outsider')).toEqual([]);
    expect((await act(EXT, 'nope', {}, member.cookie)).status).toBe(404);
  });

  // The manifest's default action is `execute`: a role must hold it for any
  // action to be reachable by someone who is not an administrator.
  it('a tenant member runs an action on a declared resource by default', async () => {
    const res = await act(EXT, 'addItem', { label: 'by-tenant-member' }, tenantMember.cookie);
    expect(res.status).toBe(200);
    expect((await rowsLabelled('by-tenant-member')).map((r) => r.created_by)).toEqual([
      tenantMember.userId,
    ]);
  });

  it('a tenant viewer is refused an action', async () => {
    const res = await act(EXT, 'addItem', { label: 'by-tenant-viewer' }, tenantViewer.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_required');
    expect(await rowsLabelled('by-tenant-viewer')).toEqual([]);
  });

  it('grants execute on extension resources only, never on collections or sensitive ones', async () => {
    const execute = async (resource: string) =>
      (
        await sql<{ v0: string }>`
          SELECT v0 FROM zvd_permissions
          WHERE ptype = 'p' AND v1 = '*' AND v2 = ${resource} AND v3 = 'execute'
            AND v0 IN ('tenant_member', 'tenant_viewer')
        `.execute(db)
      ).rows.map((r) => r.v0);
    expect(await execute(RES)).toEqual(['tenant_member']);
    expect(await execute(C)).toEqual([]);
    expect((await sql`SELECT 1 FROM zvd_permissions WHERE v2 = ${SENS}`.execute(db)).rows).toEqual(
      [],
    );
    const res = await act(SENSEXT, 'go', {}, tenantMember.cookie);
    expect(res.status).toBe(403);
  });

  it('a tenant member holding execute is still refused a write the collection refuses', async () => {
    // The action's writes go through the data API as the caller: `execute`
    // opens the action, not the collections it touches.
    const rule = ['tenant_member', '*', C, 'create'];
    const e = await getEnforcer();
    await e.removePolicy(...rule);
    await invalidateAllPermissionCaches();
    try {
      const res = await act(EXT, 'addItem', { label: 'member-refused' }, tenantMember.cookie);
      // Past the action's own gate: refused by the data API, not `permission_required`.
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('action_data_refused');
      expect(await rowsLabelled('member-refused')).toEqual([]);
    } finally {
      await e.addPolicy(...rule);
      await invalidateAllPermissionCaches();
    }
  });

  it('refuses an input the declared schema does not accept', async () => {
    for (const body of [{}, { label: '' }, { label: 7 }, { label: 'x', extra: true }]) {
      const res = await act(EXT, 'addItem', body, member.cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    }
    expect(await rowsLabelled('x')).toEqual([]);
  });

  it('refuses a collection the action does not declare', async () => {
    for (const mode of ['read', 'write']) {
      expect((await act(EXT, 'sneak', { mode }, member.cookie)).status).toBe(500);
    }
    expect(await rowsLabelled('sneaked')).toEqual([]);
  });

  it('rolls back what the action wrote when it throws', async () => {
    const res = await act(EXT, 'addThenThrow', { label: 'rolled-back' }, member.cookie);
    expect(res.status).toBe(500);
    expect(await rowsLabelled('rolled-back')).toEqual([]);
  });

  it('is not intercepted by the extension’s own middleware', async () => {
    // The catch-all is live for the extension's routes...
    const ping = await app.request(`/ext/${EXT}/ping`, { headers: { cookie: member.cookie } });
    expect(ping.status).toBe(418);
    // ...and never sees an action request.
    expect((await act(EXT, 'addItem', { label: 'past-mw' }, member.cookie)).status).toBe(200);
  });

  it('audits each run with its caller and outcome', async () => {
    const added = await auditRows('addItem');
    expect(added.length).toBeGreaterThan(0);
    expect(added[0]).toMatchObject({
      user_id: member.userId,
      metadata: { extension: EXT, action: 'addItem', outcome: 'success', status: 200 },
    });
    // The failed run is recorded although its transaction rolled back.
    expect(await auditRows('addThenThrow')).toEqual([
      {
        user_id: member.userId,
        metadata: { extension: EXT, action: 'addThenThrow', outcome: 'failure', status: 500 },
      },
    ]);
  });

  it('writes only with the extension’s data:write capability', async () => {
    const res = await act(NOCAP, 'addItem', { label: 'nocap' }, member.cookie);
    expect(res.status).toBe(500);
    expect(await rowsLabelled('nocap')).toEqual([]);
  });

  it('refuses to run outside a request transaction', async () => {
    // The same chain without the tenant middleware: each write would commit alone.
    const bare = new Hono();
    bare.use('/ext/*', sessionPrefetch(getAuth(), db));
    bare.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(
      {
        name: NOTRX,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: {
          addItem: (input, host) => host.collections.insert(C, input as Record<string, unknown>),
        },
        async register() {},
      },
      {
        permissions: ['data:write'],
        resources: [RES],
        actions: [
          { name: 'addItem', permission: { resource: RES }, input: labelInput, writes: [C] },
        ],
      },
      bare,
    );
    invalidateActivationCache();
    const res = await bare.request(`/ext/${NOTRX}/actions/addItem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ label: 'no-trx' }),
    });
    expect(res.status).toBe(500);
    expect(await rowsLabelled('no-trx')).toEqual([]);
  });

  it('refuses to load when the manifest and the module disagree', async () => {
    const action = { name: 'go', permission: { resource: RES }, input: { type: 'object' } };
    const ext = (actions: ZveltioExtension['actions'], mountStrategy = 'subapp' as const) =>
      ({ name: REFUSED, category: 'custom', mountStrategy, actions, async register() {} }) as const;
    const go = async () => null;
    await expect(load(ext({}), { resources: [RES], actions: [action] })).rejects.toThrow(
      'has no implementation',
    );
    await expect(load(ext({ go }), { resources: [RES] })).rejects.toThrow('not declared');
    await expect(
      load({ ...ext({ go }), mountStrategy: 'global' }, { resources: [RES], actions: [action] }),
    ).rejects.toThrow("mountStrategy 'subapp'");
    // The manifest itself refuses an unusable schema and an undeclared resource.
    expect(
      ManifestSchema.safeParse({
        name: REFUSED,
        resources: [RES],
        actions: [{ ...action, input: { type: 'bogus' } }],
      }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({ name: REFUSED, resources: [], actions: [action] }).success,
    ).toBe(false);
  });
});

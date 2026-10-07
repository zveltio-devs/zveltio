// Collection permissions, enforced by the database (roadmap R1).
//
// `checkPermission(user, collection, action)` was the application's question
// only, so a path that skipped it read and wrote freely inside the tenant. Every
// statement here SKIPS the application check on purpose — raw SQL in the
// tenant transaction, as `zveltio_rls` — and the table answers:
//
//   - a user without a grant reads nothing and writes nothing (on master: every
//     row, and every write lands);
//   - the database's answer is `checkPermission`'s, role chains included;
//   - the engine's own work (no actor) and a bypassing caller are unaffected;
//   - an extension's statement gets the actor's rights, nothing without an
//     actor, its collections inside `asSystem`, and everything only when the
//     operator exempts it — which never exempts an engine route;
//   - an anonymous request gets the tenant's `public` grants, in its tenant only.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  applyTenantRLS,
  checkPermission,
  collectionGrantsFor,
  encodeApiKeyScopes,
  getCurrentTenantTrx,
  getEnforcer,
  getRequestActor,
  invalidateAllPermissionCaches,
  publishApiKeyActor,
  type RlsIdentity,
  runWithDomain,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SFX = String(Date.now()).slice(-7);
const COLL = `cperm_${SFX}`;
const PRIVATE = `cpriv_${SFX}`;
const TABLE = `zvd_${COLL}`;
const EXT = `cpext${SFX}`;
const ROLE_A = `cperm-a-${SFX}`;
const ROLE_B = `cperm-b-${SFX}`;
const U = {
  nobody: `cperm-nobody-${SFX}`,
  reader: `cperm-reader-${SFX}`,
  chained: `cperm-chained-${SFX}`,
  admin: `cperm-admin-${SFX}`,
};
// Exempt from row rules, each for its own reason — kept out of `U`, whose loop
// below holds the database to `checkPermission` on the collection itself.
// The instance holds one god at most; another file may already have made it.
const OWN_GOD = `cperm-god-${SFX}`;
let GOD = OWN_GOD;
const VIEW_ALL = `cperm-viewall-${SFX}`;

d('collection permissions in the database (R1)', () => {
  let db: Database;

  // Built as `tenantMiddleware` builds a session's: the bypass is the
  // `data:view_all` answer, the grants `collectionGrantsFor`'s.
  const identityOf = (userId: string): Promise<RlsIdentity> =>
    runWithDomain(TENANT, async () => {
      const g = await collectionGrantsFor(userId);
      return {
        userId,
        email: '',
        role: '',
        roles: [],
        bypass: await checkPermission(userId, 'data', 'view_all'),
        collectionGrants: g.grants,
        collectionAll: g.all,
      };
    });
  const anonymous = async (): Promise<RlsIdentity> => {
    const g = await runWithDomain(TENANT, () => collectionGrantsFor('public'));
    return {
      userId: '',
      email: '',
      role: 'public',
      roles: ['public'],
      bypass: false,
      collectionGrants: g.grants,
      collectionAll: g.all,
      anonymous: true,
    };
  };
  const as = <T>(
    identity: RlsIdentity | undefined,
    fn: (trx: Database) => Promise<T>,
    tenant = TENANT,
  ) => withTenantIsolation(tenant, fn, identity ? { identity } : undefined);
  const count = async (h: Database, table = TABLE) =>
    (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(h))
      .rows[0]!.n;
  /** INSERT, answering whether the table took it — the application never asked. */
  const inserts = (h: Database) =>
    sql`INSERT INTO ${sql.table(TABLE)} (title) VALUES ('probe')`.execute(h).then(
      () => true,
      (e: Error) => {
        if (/row-level security|zv_coll_create/.test(e.message)) return false;
        throw e;
      },
    );
  const updates = async (h: Database) =>
    Number(
      (await sql`UPDATE ${sql.table(TABLE)} SET title = title`.execute(h)).numAffectedRows ?? 0n,
    );
  const deletes = async (h: Database) =>
    Number(
      (await sql`DELETE FROM ${sql.table(TABLE)} WHERE title = 'never-matches'`.execute(h))
        .numAffectedRows ?? 0n,
    );
  const deleteAll = async (h: Database) =>
    Number((await sql`DELETE FROM ${sql.table(TABLE)}`.execute(h)).numAffectedRows ?? 0n);
  /** A rolled-back attempt: the assertions are about the answer, not the data. */
  const attempt = <T>(identity: RlsIdentity | undefined, fn: (trx: Database) => Promise<T>) =>
    as(identity, async (trx) => {
      const out = await fn(trx);
      throw Object.assign(new Error('rollback'), { out });
    }).catch((e: { out?: T }) => {
      if ('out' in e) return e.out as T;
      throw e;
    });

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${`cperm-${SFX}`}, 'other', 'active')`.execute(db);
    for (const id of [...Object.values(U), OWN_GOD, VIEW_ALL]) {
      await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
                VALUES (${id}, ${id}, ${`${id}@example.test`}, true, now(), now())`.execute(db);
    }
    const existing = await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(
      db,
    );
    if (existing.rows[0]) GOD = existing.rows[0].id;
    else await sql`UPDATE "user" SET role = 'god' WHERE id = ${GOD}`.execute(db);
    for (const name of [COLL, PRIVATE]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
      await applyTenantRLS(db, `zvd_${name}`);
    }
    await sql`INSERT INTO ${sql.table(TABLE)} (title, tenant_id) VALUES
                ('a', ${TENANT}::uuid), ('b', ${TENANT}::uuid), ('other', ${OTHER}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO ${sql.table(`zvd_${PRIVATE}`)} (title, tenant_id)
              VALUES ('secret', ${TENANT}::uuid)`.execute(db);

    const e = await getEnforcer();
    await e.addPolicy(U.reader, '*', COLL, 'read');
    // A chain: chained → A → B, and only B holds the grant.
    await e.addRoleForUser(U.chained, ROLE_A, '*');
    await e.addRoleForUser(ROLE_A, ROLE_B, '*');
    await e.addPolicy(ROLE_B, '*', COLL, 'create');
    await e.addPolicy(ROLE_B, '*', COLL, 'read');
    await e.addPolicy(U.admin, TENANT, '*', '*');
    await e.addPolicy('public', TENANT, COLL, 'read');
    await e.addPolicy(VIEW_ALL, '*', 'data', 'view_all');
    await invalidateAllPermissionCaches();

    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, EXT, new Set());
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    delete process.env.ZVELTIO_COLLECTION_RLS_EXEMPT;
    await grantExtensionDbRole(db, EXT, new Set()).catch(() => undefined);
    const e = await getEnforcer();
    await e.removePolicy(U.reader, '*', COLL, 'read');
    await e.deleteRoleForUser(U.chained, ROLE_A, '*');
    await e.deleteRoleForUser(ROLE_A, ROLE_B, '*');
    await e.removePolicy(ROLE_B, '*', COLL, 'create');
    await e.removePolicy(ROLE_B, '*', COLL, 'read');
    await e.removePolicy(U.admin, TENANT, '*', '*');
    await e.removePolicy('public', TENANT, COLL, 'read');
    await e.removePolicy(VIEW_ALL, '*', 'data', 'view_all');
    await invalidateAllPermissionCaches();
    for (const name of [COLL, PRIVATE]) await dropTestCollection(db, name).catch(() => {});
    for (const id of [...Object.values(U), OWN_GOD, VIEW_ALL]) {
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
    _resetExtensionDbRoleForTests();
  });

  it('a user without a grant reads nothing and writes nothing, the application check skipped', async () => {
    const nobody = await identityOf(U.nobody);
    expect(await attempt(nobody, (t) => count(t))).toBe(0);
    expect(await attempt(nobody, (t) => inserts(t))).toBe(false);
    expect(await attempt(nobody, (t) => updates(t))).toBe(0);
    expect(await attempt(nobody, (t) => deletes(t))).toBe(0);
  });

  it('a read grant reads, and only reads', async () => {
    const reader = await identityOf(U.reader);
    expect(await attempt(reader, (t) => count(t))).toBe(2);
    expect(await attempt(reader, (t) => inserts(t))).toBe(false);
    expect(await attempt(reader, (t) => updates(t))).toBe(0);
  });

  it('answers what checkPermission answers — role chains, tenant admins and all', async () => {
    for (const user of Object.values(U)) {
      const identity = await identityOf(user);
      const app = await runWithDomain(TENANT, async () => ({
        read: await checkPermission(user, COLL, 'read'),
        create: await checkPermission(user, COLL, 'create'),
      }));
      const database = {
        read: (await attempt(identity, (t) => count(t))) > 0,
        create: await attempt(identity, (t) => inserts(t)),
      };
      expect({ user, ...database }).toEqual({ user, ...app });
    }
    // The chain is what made the difference: the grant sits two roles away.
    expect(await attempt(await identityOf(U.chained), (t) => inserts(t))).toBe(true);
  });

  it("leaves the engine's own work and a god alone", async () => {
    // No actor: boot, reconcilers, jobs.
    expect(await attempt(undefined, (t) => count(t))).toBe(2);
    // A god: every action, as `checkPermission` answers — with no Casbin grant.
    const god = await identityOf(GOD);
    expect(god.bypass).toBe(true);
    expect(await attempt(god, (t) => count(t))).toBe(2);
    expect(await attempt(god, (t) => inserts(t))).toBe(true);
    expect(await attempt(god, (t) => updates(t))).toBe(2);
    expect(await attempt(god, (t) => deleteAll(t))).toBe(2);
  });

  it('lets `data:view_all` read every row and write nothing it was not granted', async () => {
    // The same `rls_bypass` a god publishes. On the first cut the function
    // passed EVERY action for it, so a read-only exemption wrote everywhere.
    const viewAll = await identityOf(VIEW_ALL);
    expect(viewAll.bypass).toBe(true);
    expect(await attempt(viewAll, (t) => count(t))).toBe(2);
    expect(await attempt(viewAll, (t) => inserts(t))).toBe(false);
    expect(await attempt(viewAll, (t) => updates(t))).toBe(0);
    expect(await attempt(viewAll, (t) => deleteAll(t))).toBe(0);
    // An API key's `rls_bypass` is the same exemption: its scopes still decide.
    const key = await attempt(await anonymous(), async (t) => {
      await publishApiKeyActor('apikey:probe', true, [{ collection: COLL, actions: ['read'] }]);
      return [await count(t), await inserts(t)];
    });
    expect(key).toEqual([2, false]);
  });

  it("holds an extension's statement to the actor, to nothing without one, and opens asSystem's collections", async () => {
    const ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set());
    const asExt = () => count(ext as unknown as Database);
    // With the reader's request: the reader's rights.
    expect(await attempt(await identityOf(U.reader), asExt)).toBe(2);
    // No actor — a job: nothing.
    expect(await attempt(undefined, asExt)).toBe(0);
    // Inside asSystem for this collection: the tenant's rows, its tenant only.
    const internals = gateInternals(EXT, buildExtensionInternals(), ['data:system']);
    expect(await attempt(await identityOf(U.nobody), () => internals.asSystem([COLL], asExt))).toBe(
      2,
    );
    // ...and only for the collections it named.
    expect(
      await attempt(await identityOf(U.nobody), () =>
        internals.asSystem([COLL], () => count(ext as unknown as Database, `zvd_${PRIVATE}`)),
      ),
    ).toBe(0);
  });

  it('exempts a listed extension, and never an engine route', async () => {
    const ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set());
    process.env.ZVELTIO_COLLECTION_RLS_EXEMPT = `other-ext, ${EXT}`;
    try {
      await grantExtensionDbRole(db, EXT, new Set());
      expect(await attempt(undefined, () => count(ext as unknown as Database))).toBe(2);
      // The engine's own statement for the same user is still refused.
      expect(await attempt(await identityOf(U.nobody), (t) => count(t))).toBe(0);
    } finally {
      delete process.env.ZVELTIO_COLLECTION_RLS_EXEMPT;
      await grantExtensionDbRole(db, EXT, new Set());
    }
    expect(await attempt(undefined, () => count(ext as unknown as Database))).toBe(0);
  });

  it("gives an anonymous request the public role's grants, in its own tenant only", async () => {
    const anon = await anonymous();
    // `public` reads this collection — this tenant's rows, not the other's.
    expect(await attempt(anon, (t) => count(t))).toBe(2);
    // ...creates nothing, and reads nothing it was not given.
    expect(await attempt(anon, (t) => inserts(t))).toBe(false);
    expect(await attempt(anon, (t) => count(t, `zvd_${PRIVATE}`))).toBe(0);
    // The other tenant's public role holds nothing here.
    const otherAnon = { ...anon, collectionGrants: '' };
    expect(await as(otherAnon, (t) => count(t), OTHER).catch(() => -1)).toBe(0);
  });

  it("holds a worker's query to the caller's grants, never the caller's bypass", async () => {
    // One `db:query` through the host, as a worker's `ctx.db` sends it for a
    // request the host recorded as served by `identity` in TENANT.
    const viaWorker = async (identity: RlsIdentity) => {
      const reply = await new Promise<HostToWorkerMessage>((resolve) => {
        const managed = {
          name: EXT,
          worker: { postMessage: resolve, terminate: () => {} },
          invokeTenants: new Map([
            ['req-1', { tenantId: TENANT, actor: { userId: null, identity } }],
          ]),
          pendingInvokes: new Map(),
          pendingInits: new Map(),
          pendingPings: new Map(),
          registeredServices: new Set<string>(),
          routes: [],
        };
        _internalForTests.dispatchMessage(
          new WorkerExtensionHost(new Hono()),
          managed as never,
          {
            type: 'db:query',
            id: 'q-1',
            requestId: 'req-1',
            sql: `SELECT count(*)::int AS n FROM ${TABLE}`,
            params: [],
          } as never,
        );
      });
      if (reply.type !== 'db:ok') throw new Error(String((reply as { error?: string }).error));
      return (reply.rows as { n: number }[])[0]!.n;
    };
    expect(await viaWorker(await identityOf(U.reader))).toBe(2);
    expect(await viaWorker(await identityOf(U.nobody))).toBe(0);
    // The bypass stays with the engine: a worker gets the caller's grants only.
    expect(await viaWorker({ ...(await identityOf(U.nobody)), bypass: true })).toBe(0);
    expect(await viaWorker(await anonymous())).toBe(2);
    // An API key's scopes reach the record the host takes for its worker calls.
    const key = await attempt(await anonymous(), async () => {
      await publishApiKeyActor('apikey:probe', false, [{ collection: COLL, actions: ['read'] }]);
      return getRequestActor()?.identity;
    });
    expect(await viaWorker(key as RlsIdentity)).toBe(2);
    const noScope = await attempt(await anonymous(), async () => {
      await publishApiKeyActor('apikey:probe', false, [{ collection: PRIVATE, actions: ['read'] }]);
      return getRequestActor()?.identity;
    });
    expect(await viaWorker(noScope as RlsIdentity)).toBe(0);
  });

  it("encodes an API key's scopes as checkAccess reads them", () => {
    expect(encodeApiKeyScopes([{ collection: '*', actions: ['*'] }])).toEqual({
      all: true,
      grants: '',
    });
    expect(encodeApiKeyScopes([{ collection: 'posts', actions: ['write', 'read'] }])).toEqual({
      all: false,
      grants: ',posts:create,posts:update,posts:read,',
    });
    expect(encodeApiKeyScopes([{ collection: '*', actions: ['read'] }]).grants).toBe(',*:read,');
    expect(encodeApiKeyScopes('not json')).toEqual({ all: false, grants: '' });
    expect(encodeApiKeyScopes([])).toEqual({ all: false, grants: '' });
  });
});

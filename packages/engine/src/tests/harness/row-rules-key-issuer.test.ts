/**
 * A key's row rules are its own AND its issuer's.
 *
 * Broken: row rules (`zvd_rls_policies`) for an API key applied only the key's
 * roles — `api_key`, the key principal's Casbin roles and `*` — in the engine
 * (`getRlsFilters`), in the realtime matcher fed by it, and in the database
 * policy (`zv_row_rules`, keyed on `zveltio.user_roles`, which is `api_key` for
 * a key). A rule binding the issuer's role never reached the issuer's key, so a
 * member whose rule shows them only bucket `a` minted a key that read `a` and
 * `b`. The docs promise a key never exceeds its issuer; migration 095 kept that
 * promise for column rules only.
 *
 * Fixed: the issuer's half is applied as the issuer — their Casbin roles and
 * `*`, with `user_id`/`user_email`/`user_role` resolved to the issuer — and
 * ANDed with the key's own half, in all three places. The issuer's half is
 * waived exactly where a session's rules are: when the issuer holds
 * `data:view_all`. A key whose issuer is unknown sees nothing a rule covers.
 *
 * Driven through `authenticate()`, the one place a key is resolved, so it proves
 * what a request publishes, not what a hand-built identity would.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { authenticate, realtimeIdentity } from '../../lib/data/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  getEnforcer,
  grantMemberRole,
  invalidateUserPermCache,
} from '../../lib/tenancy/permissions.js';
import {
  getRlsFilters,
  invalidateRlsCache,
  matchesRlsFilters,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hrowissuer_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;
const ROLE = `rowissuer_${STAMP}`;
const KEY_ROLE = `rowkey_${STAMP}`;

const field = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d("a key's row rules are its own AND its issuer's", () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let db: Database;
  let issuer = '';
  let keyId = '';
  let raw = '';

  // (bucket, owner): the issuer's rules keep bucket `a` they own; the key's
  // keep buckets `a` and `b`. Only row 1 satisfies both.
  const ROWS = [
    ['r1', 'a', 'issuer'],
    ['r2', 'b', 'issuer'],
    ['r3', 'a', 'someone-else'],
    ['r4', 'c', 'issuer'],
  ] as const;

  const ctxFor = () => ({
    get: (k: string) => (k === 'prefetchedSession' ? null : undefined),
    req: {
      header: (h: string) => (h === 'X-API-Key' ? raw : undefined),
      raw: { headers: new Headers() },
    },
  });

  /** Titles the data API serves the key. */
  const viaApi = async () => {
    const res = await app.request(`/api/data/${COLLECTION}?limit=50`, {
      headers: { 'X-API-Key': raw },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title: string }> };
    return body.records.map((r) => r.title).sort();
  };

  /** Titles a raw statement under the key's identity reads: the database policy alone. */
  const viaDatabase = () =>
    withTenantIsolation(
      DEFAULT_TENANT_ID,
      async (trx) => {
        const who = await authenticate(ctxFor() as never, {} as never, db);
        expect(who?.user.id).toBe(`apikey:${keyId}`);
        const r = await sql<{ title: string }>`
          SELECT title FROM ${sql.table(TABLE)} ORDER BY title`.execute(trx);
        return r.rows.map((x) => x.title);
      },
      { userId: null },
    );

  /** Titles the realtime doors deliver: the identity they keep, the matcher they run. */
  const viaRealtime = () =>
    withTenantIsolation(
      DEFAULT_TENANT_ID,
      async () => {
        const who = await authenticate(ctxFor() as never, {} as never, db);
        const rt = realtimeIdentity(who!)!;
        const filters = await getRlsFilters(COLLECTION, rt.user, rt.authType);
        return ROWS.map(([title, bucket, owner]) => ({
          title,
          bucket,
          owner: owner === 'issuer' ? issuer : owner,
        }))
          .filter((row) => matchesRlsFilters(row, filters))
          .map((row): string => row.title);
      },
      { userId: null },
    );

  const rule = (role: string, field: string, op: string, source: string) =>
    sql`INSERT INTO zvd_rls_policies
          (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
        VALUES (${COLLECTION}, ${role}, ${field}, ${op}, ${source}, true)`.execute(db);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [field('title'), field('bucket'), field('owner')],
    } as never);

    // A member granted the collection through `ROLE`, a role of its own — not
    // `admin`, whose `('*','*')` would also grant `data:view_all`.
    issuer = `harness-rowissuer-${crypto.randomUUID()}`;
    await sql`INSERT INTO "user" (id, name, email)
              VALUES (${issuer}, 'Harness issuer', ${`${issuer}@test.local`})`.execute(db);
    for (const [title, bucket, owner] of ROWS) {
      await sql`INSERT INTO ${sql.table(TABLE)} (tenant_id, title, bucket, owner)
                VALUES (${DEFAULT_TENANT_ID}::uuid, ${title}, ${bucket},
                        ${owner === 'issuer' ? issuer : owner})`.execute(db);
    }
    const e = await getEnforcer();
    await e.addPolicy(ROLE, '*', COLLECTION, 'read');
    await e.addRoleForUser(issuer, ROLE, '*');
    await grantMemberRole(issuer);
    await invalidateUserPermCache(issuer);

    await rule(ROLE, 'bucket', 'eq', 'static:a');
    await rule(ROLE, 'owner', 'eq', 'user_id');
    await rule('api_key', 'bucket', 'in', 'static:a,b');
    await invalidateRlsCache(COLLECTION);

    raw = generateApiKey();
    keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('issuer row probe', ${await hashApiKey(raw)}, 'zvk_', ${JSON.stringify([{ collection: COLLECTION, actions: ['read'] }])}::jsonb, 100, true,
                ${DEFAULT_TENANT_ID}::uuid, ${issuer})
        RETURNING id`.execute(db)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ROLE).catch(() => {});
    await e.deleteRolesForUser(issuer).catch(() => {});
    await e.deleteRolesForUser(`apikey:${keyId}`).catch(() => {});
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${issuer}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('the data API serves the key only what both halves keep', async () => {
    expect(await viaApi()).toEqual(['r1']);
  });

  it('a raw statement under the key identity meets the issuer half in the database', async () => {
    expect(await viaDatabase()).toEqual(['r1']);
  });

  it('the realtime matcher applies the issuer half too', async () => {
    expect(await viaRealtime()).toEqual(['r1']);
  });

  it('an issuer exempt from row rules (data:view_all) waives only their half', async () => {
    const e = await getEnforcer();
    await e.addPolicy(ROLE, '*', 'data', 'view_all');
    await invalidateUserPermCache(issuer);
    try {
      const keyHalf = ['r1', 'r2', 'r3'];
      expect(await viaApi()).toEqual(keyHalf);
      expect(await viaDatabase()).toEqual(keyHalf);
      expect(await viaRealtime()).toEqual(keyHalf);
    } finally {
      await e.removePolicy(ROLE, '*', 'data', 'view_all');
      await invalidateUserPermCache(issuer);
    }
  });

  // Broken: the database published `zveltio.user_roles = 'api_key'` for every
  // key while `getRlsFilters` also applies the key principal's Casbin roles, so
  // a rule on a role the key holds bound the data API and realtime but not a raw
  // statement under the key's identity. Reachable: POST /api/permissions/roles
  // takes any subject string, `apikey:<uuid>` included.
  it('a role the key principal holds binds it in the database as in the engine', async () => {
    const cookie = await createGodSession(app, db);
    const res = await app.request('/api/permissions/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: `apikey:${keyId}`, role: KEY_ROLE }),
    });
    expect(res.status).toBe(200);
    await rule(KEY_ROLE, 'bucket', 'eq', 'static:b');
    await invalidateRlsCache(COLLECTION);
    try {
      // The issuer half keeps only r1 (bucket a); the key's role keeps bucket b.
      expect(await viaRealtime()).toEqual([]);
      expect(await viaDatabase()).toEqual([]);
      expect(await viaApi()).toEqual([]);
    } finally {
      await (await getEnforcer()).deleteRolesForUser(`apikey:${keyId}`);
      await invalidateUserPermCache(`apikey:${keyId}`);
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION} AND role = ${KEY_ROLE}`.execute(
        db,
      );
      await invalidateRlsCache(COLLECTION);
    }
  });

  it('a key with no issuer known sees nothing a rule covers', async () => {
    const filters = await getRlsFilters(
      COLLECTION,
      { id: `apikey:${keyId}`, authorUserId: null, rlsBypass: false },
      'api_key',
    );
    const rows = ROWS.map(([title, bucket, owner]) => ({ title, bucket, owner }));
    expect(rows.filter((r) => matchesRlsFilters(r, filters))).toEqual([]);
  });
});

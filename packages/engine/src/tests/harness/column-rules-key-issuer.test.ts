/**
 * L37 — a key's column rules in the database are its own AND its issuer's
 * (migration 095).
 *
 * The engine bounds a key's columns by its issuer's rules (`keyColumnAccess`),
 * but the database layers — the write guard (072), the masking views (075) and
 * the revision view (077) — read one role, `zveltio.user_role`, which for a key
 * is `api_key`. A column hidden from the issuer's role was therefore read back
 * through `zvv_<collection>` and written straight onto the table by any
 * statement that reached the database under the key's identity. The issuer's
 * role is now published as `zveltio.issuer_role` and all three apply it.
 *
 * Driven through `authenticate()`, the one place a key is resolved, so the test
 * proves what the request publishes, not what a hand-built identity would.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { authenticate } from '../../lib/data/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import { getColumnAccess } from '../../lib/tenancy/column-permissions.js';
import {
  getEnforcer,
  grantMemberRole,
  invalidateUserPermCache,
} from '../../lib/tenancy/permissions.js';
import { putColumnPermission, withTenantIsolation } from '../../lib/tenancy/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hkeyissuer_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;
const VIEW = `zvv_${COLLECTION}`;
const ROLE = `issuerrole_${STAMP}`;

const field = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d('a key meets its issuer column rules in the database (migration 095)', () => {
  let db: Database;
  let issuer = '';
  let keyId = '';
  let raw = '';
  let recordId = '';

  /** Run `fn` on the request transaction, as the key, the way a request publishes it. */
  const asKey = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(
      DEFAULT_TENANT_ID,
      async (trx) => {
        const ctx = {
          get: (k: string) => (k === 'prefetchedSession' ? null : undefined),
          req: {
            header: (h: string) => (h === 'X-API-Key' ? raw : undefined),
            raw: { headers: new Headers() },
          },
        };
        const who = await authenticate(ctx as never, {} as never, db);
        expect(who?.user.id).toBe(`apikey:${keyId}`);
        return fn(trx);
      },
      { userId: null },
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [field('title'), field('secret')],
    } as never);
    recordId = (
      await sql<{ id: string }>`
        INSERT INTO ${sql.table(TABLE)} (tenant_id, title, secret)
        VALUES (${DEFAULT_TENANT_ID}::uuid, 'seed', 'classified') RETURNING id`.execute(db)
    ).rows[0]!.id;

    // A member (the role column rules are keyed on) granted this collection
    // through `ROLE`, a role of its own: not `admin`, whose `('*','*')` would
    // also grant `data:view_all_columns` and exempt the issuer's half.
    issuer = `harness-issuer-${crypto.randomUUID()}`;
    await sql`INSERT INTO "user" (id, name, email)
              VALUES (${issuer}, 'Harness issuer', ${`${issuer}@test.local`})`.execute(db);
    const e = await getEnforcer();
    for (const action of ['read', 'update']) await e.addPolicy(ROLE, '*', COLLECTION, action);
    await e.addRoleForUser(issuer, ROLE, '*');
    await grantMemberRole(issuer);
    await invalidateUserPermCache(issuer);
    await putColumnPermission(db, {
      collection_name: COLLECTION,
      column_name: 'secret',
      role: 'member',
      can_read: false,
      can_write: false,
    });

    raw = generateApiKey();
    keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('issuer column probe', ${await hashApiKey(raw)}, 'zvk_', ${JSON.stringify([{ collection: COLLECTION, actions: ['read', 'update'] }])}::jsonb, 100, true,
                ${DEFAULT_TENANT_ID}::uuid, ${issuer})
        RETURNING id`.execute(db)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ROLE).catch(() => {});
    await e.deleteRolesForUser(issuer).catch(() => {});
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${issuer}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('the engine hides the column from the key (the layer the database must match)', async () => {
    const access = await getColumnAccess(db, COLLECTION, 'api_key', {
      id: `apikey:${keyId}`,
      authorUserId: issuer,
    });
    expect(access.hidden.has('secret')).toBe(true);
  });

  it('publishes the issuer role next to the key role', async () => {
    const r = await asKey((trx) =>
      sql<{ k: string; i: string }>`
        SELECT current_setting('zveltio.user_role') AS k,
               current_setting('zveltio.issuer_role', true) AS i`.execute(trx),
    );
    expect(r.rows[0]).toEqual({ k: 'api_key', i: 'member' });
  });

  it('the masking view withholds the column the issuer may not read', async () => {
    const r = await asKey((trx) =>
      sql<{ title: string; secret: string | null }>`
        SELECT title, secret FROM ${sql.table(VIEW)} WHERE id = ${recordId}::uuid`.execute(trx),
    );
    expect(r.rows).toEqual([{ title: 'seed', secret: null }]);
  });

  it('the write guard refuses a change to that column, and passes the others', async () => {
    const err = await asKey((trx) =>
      sql`UPDATE ${sql.table(TABLE)} SET secret = 'overwritten' WHERE id = ${recordId}::uuid`.execute(
        trx,
      ),
    ).then(
      () => null,
      (e: { errno?: string; message?: string }) => e,
    );
    expect(err?.errno).toBe('42501');
    expect(err?.message).toContain('secret');

    const ok = await asKey((trx) =>
      sql`UPDATE ${sql.table(TABLE)} SET title = 'renamed' WHERE id = ${recordId}::uuid`.execute(
        trx,
      ),
    );
    expect(Number(ok.numAffectedRows)).toBe(1);
  });

  it('the revision view strips the column from history', async () => {
    await sql`
      INSERT INTO zv_revisions (tenant_id, collection, record_id, action, data, delta, user_id)
      VALUES (${DEFAULT_TENANT_ID}::uuid, ${COLLECTION}, ${recordId}, 'update',
              '{"title":"seed","secret":"classified"}'::jsonb, '{"secret":"classified"}'::jsonb, ${issuer})
    `.execute(db);
    const r = await asKey((trx) =>
      sql<{ d: string | null; x: string | null }>`
        SELECT data->>'secret' AS d, delta->>'secret' AS x FROM zvv__revisions
         WHERE collection = ${COLLECTION} AND record_id = ${recordId}`.execute(trx),
    );
    expect(r.rows).toEqual([{ d: null, x: null }]);
  });
});

/**
 * Keys, invitations, share links and memberships are isolated by Postgres (065).
 *
 * `zv_api_keys`, `zv_invitations`, `zv_media_shares` and `zv_tenant_users`
 * carried `tenant_id` and no policy: any SQL in a tenant transaction that did not
 * write `where tenant_id = …` read and wrote every tenant's rows, and three of
 * them put a row that named no tenant into the ROOT tenant — for a key, the kind
 * that acts in every tenant. Here each one is read, written and deleted from the
 * wrong tenant, and the doors that read them before a tenant exists are walked
 * as the plain role a production install connects as.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { deleteUser } from '../../lib/users.js';
import {
  asTenant,
  connectedAsSuperuser,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = DEFAULT_TENANT_ID;
const PARENT = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const TAG = `idrls-${Date.now()}`;
const USER = `${TAG}-user`;
const LEAVER = `${TAG}-leaver`;
const OWNER = `zv_idrls_owner_${Date.now()}`;
const TABLES = ['zv_api_keys', 'zv_invitations', 'zv_media_shares', 'zv_tenant_users'] as const;
const FUNCTIONS = [
  'zveltio_user_memberships(text)',
  'zveltio_media_share_tenant(text)',
  'zveltio_revoke_user_api_keys(text)',
];

/** The rows this file made in each table, as `table:tenant`, whatever reads them. */
const tagged = sql<{ row: string }>`
  SELECT 'zv_api_keys:' || tenant_id FROM zv_api_keys WHERE created_by = ${USER}
  UNION ALL SELECT 'zv_invitations:' || tenant_id FROM zv_invitations WHERE email LIKE ${`${TAG}%`}
  UNION ALL SELECT 'zv_media_shares:' || tenant_id FROM zv_media_shares WHERE token LIKE ${`${TAG}%`}
  UNION ALL SELECT 'zv_tenant_users:' || tenant_id FROM zv_tenant_users WHERE user_id = ${USER}`;
const rowsOf = (tenant: string) => TABLES.map((t) => `${t}:${tenant}`);
const read = async (db: Database) =>
  (await sql<{ row: string }>`SELECT * FROM (${tagged}) x(row)`.execute(db)).rows
    .map((r) => r.row)
    .sort();

d('identity tables under tenant RLS (065)', () => {
  let app: Hono;
  let db: Database;
  const rawKey: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    for (const id of [USER, LEAVER]) {
      await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, ${id}, ${`${id}@test.local`})`.execute(
        db,
      );
    }
    await sql`INSERT INTO zv_tenants (id, slug, name, status) VALUES
                (${PARENT}::uuid, ${`${TAG}-p`}, ${`${TAG}-p`}, 'active')`.execute(db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status, parent_id) VALUES
                (${CHILD}::uuid, ${`${TAG}-c`}, ${`${TAG}-c`}, 'active', ${PARENT}::uuid)`.execute(
      db,
    );
    // USER reads PARENT's subtree, and is a member of the child too.
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope) VALUES
                (${PARENT}::uuid, ${USER}, 'admin', 'subtree'),
                (${CHILD}::uuid, ${USER}, 'member', 'self')`.execute(db);
    for (const tenant of [ROOT, CHILD]) {
      rawKey[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, created_by, tenant_id)
        VALUES (${`${TAG}-${tenant}`}, ${await hashApiKey(rawKey[tenant]!)},
                ${rawKey[tenant]!.slice(0, 12)}, '[]'::jsonb, true, ${USER}, ${tenant}::uuid)`.execute(
        db,
      );
      await sql`
        INSERT INTO zv_invitations (email, role, token, expires_at, tenant_id)
        VALUES (${`${TAG}-${tenant}@test.local`}, 'member', ${`${TAG}-${tenant}`},
                now() + interval '1 day', ${tenant}::uuid)`.execute(db);
      const folder = await asTenant(db, tenant, (trx) =>
        sql<{ id: string }>`
        INSERT INTO zv_media_folders (name, tenant_id) VALUES (${TAG}, ${tenant}::uuid)
        RETURNING id::text AS id`.execute(trx),
      );
      await asTenant(db, tenant, (trx) =>
        sql`
        INSERT INTO zv_media_shares (folder_id, token, created_by, tenant_id)
        VALUES (${folder.rows[0]!.id}::uuid, ${`${TAG}-${tenant}`}, ${USER}, ${tenant}::uuid)`.execute(
          trx,
        ),
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_invitations WHERE email LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_media_shares WHERE token LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_media_folders WHERE name = ${TAG}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE user_id IN (${USER}, ${LEAVER})`.execute(db);
    await sql`DELETE FROM "user" WHERE id IN (${USER}, ${LEAVER})`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${CHILD}::uuid, ${PARENT}::uuid)`.execute(db);
  });

  it('a tenant transaction reads its own tenant’s rows and no other', async () => {
    expect(await withTenantIsolation(CHILD, read)).toEqual(rowsOf(CHILD).sort());
    // ROOT holds no membership of USER's.
    expect(await withTenantIsolation(ROOT, read)).toEqual(
      rowsOf(ROOT)
        .filter((r) => !r.startsWith('zv_tenant_users'))
        .sort(),
    );
  });

  it('a tenant cannot write a row into another tenant', async () => {
    const insert = withTenantIsolation(CHILD, (trx) =>
      sql`INSERT INTO zv_invitations (email, role, token, expires_at, tenant_id)
          VALUES (${`${TAG}-x@test.local`}, 'member', ${`${TAG}-x`}, now(), ${ROOT}::uuid)`.execute(
        trx,
      ),
    );
    await expect(insert).rejects.toThrow(/row-level security/);
    const changed = await withTenantIsolation(CHILD, async (trx) => {
      const up = await sql`UPDATE zv_api_keys SET is_active = false
                            WHERE name = ${`${TAG}-${ROOT}`}`.execute(trx);
      const del = await sql`DELETE FROM zv_media_shares WHERE token = ${`${TAG}-${ROOT}`}`.execute(
        trx,
      );
      return Number(up.numAffectedRows ?? 0) + Number(del.numAffectedRows ?? 0);
    });
    expect(changed).toBe(0);
  });

  // A FOR ALL policy lets DELETE through on its USING — the READ predicate — so
  // a parent that reads its subtree could delete its children's rows.
  it('a parent reads its child’s rows and cannot change or delete them', async () => {
    const r = await withTenantIsolation(
      PARENT,
      async (trx) => {
        const seen = await read(trx);
        const out: number[] = [];
        for (const t of TABLES) {
          const where = sql`tenant_id = ${CHILD}::uuid`;
          const del = await sql`DELETE FROM ${sql.id(t)} WHERE ${where}`.execute(trx);
          out.push(Number(del.numAffectedRows ?? 0));
        }
        const up = await sql`UPDATE zv_tenant_users SET role = 'owner'
                              WHERE tenant_id = ${CHILD}::uuid AND user_id = ${USER}`.execute(trx);
        out.push(Number(up.numAffectedRows ?? 0));
        return { seen, out };
      },
      { userId: USER },
    );
    expect(r.seen).toEqual(expect.arrayContaining(rowsOf(CHILD)));
    expect(r.out).toEqual([0, 0, 0, 0, 0]);
    expect(await read(db)).toEqual(expect.arrayContaining(rowsOf(CHILD)));
  });

  // The root fallback default made a forgotten tenant a ROOT row.
  it('a row that names no tenant is refused, not filed under the root tenant', async () => {
    const refused = async (q: Promise<unknown>) =>
      ((await q.then(() => null).catch((e) => e)) as { errno?: string } | null)?.errno;
    expect(
      await refused(
        sql`INSERT INTO zv_api_keys (name, key_hash, key_prefix, created_by)
            VALUES (${`${TAG}-none`}, ${`${TAG}-none`}, 'zvk_none', ${USER})`.execute(db),
      ),
    ).toBe('23502');
    expect(
      await refused(
        sql`INSERT INTO zv_invitations (email, role, token, expires_at)
            VALUES (${`${TAG}-none@test.local`}, 'member', ${`${TAG}-none`}, now())`.execute(db),
      ),
    ).toBe('23502');
    const folder = await sql<{ id: string }>`
      SELECT id::text AS id FROM zv_media_folders WHERE name = ${TAG} LIMIT 1`.execute(db);
    expect(
      await refused(
        sql`INSERT INTO zv_media_shares (folder_id, token, created_by)
            VALUES (${folder.rows[0]!.id}::uuid, ${`${TAG}-none`}, ${USER})`.execute(db),
      ),
    ).toBe('23502');
  });

  it('inside a tenant, an account’s memberships elsewhere and a link’s tenant are still answered', async () => {
    const r = await withTenantIsolation(ROOT, async (trx) => ({
      memberships: (
        await sql<{ tenant_id: string }>`
          SELECT tenant_id::text AS tenant_id FROM zveltio_user_memberships(${USER})`.execute(trx)
      ).rows
        .map((x) => x.tenant_id)
        .sort(),
      share: (
        await sql<{
          t: string;
        }>`SELECT zveltio_media_share_tenant(${`${TAG}-${CHILD}`})::text AS t`.execute(trx)
      ).rows[0]?.t,
    }));
    expect(r.memberships).toEqual([CHILD, PARENT].sort());
    expect(r.share).toBe(CHILD);
  });

  // The key is found before the tenant transaction opens; its own record is
  // read inside it, where a root-tenant key acting elsewhere is not the tenant's.
  it('a key reads its own record in its tenant, and a root key in any tenant', async () => {
    for (const tenant of [CHILD, ROOT]) {
      const res = await app.request('/api/api-keys/self', {
        headers: { 'X-API-Key': rawKey[tenant]!, 'X-Tenant-Slug': `${TAG}-c` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tenant_id: string }).tenant_id).toBe(tenant);
    }
  });

  it('deleting an account inside one tenant revokes its keys in every tenant', async () => {
    for (const tenant of [ROOT, CHILD]) {
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, created_by, tenant_id)
        VALUES (${`${TAG}-leaver-${tenant}`}, ${`${TAG}-leaver-${tenant}`}, 'zvk_leaver',
                '[]'::jsonb, true, ${LEAVER}, ${tenant}::uuid)`.execute(db);
    }
    await withTenantIsolation(ROOT, (trx) =>
      deleteUser(trx, db, LEAVER, { actor: 'harness', reason: 'identity-tables-rls' }),
    );
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_api_keys
       WHERE name LIKE ${`${TAG}-leaver-%`} AND is_active`.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  });

  // The harness connects as a superuser, which no policy binds. Production
  // connects as a plain owner: FORCE binds it, and only the "outside a tenant"
  // branch lets it resolve a tenant from these tables. Rolled back.
  it('as a plain owner: every row outside a tenant, its tenant inside one, nothing for other roles', async () => {
    const rollback = new Error('rollback');
    const r: Record<string, unknown> = {};
    const superuser = await connectedAsSuperuser(db);
    await db
      .transaction()
      .execute(async (trx) => {
        // On the owner lane the harness already is that role.
        if (superuser) {
          await sql.raw(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`).execute(trx);
          for (const t of TABLES) await sql.raw(`ALTER TABLE ${t} OWNER TO ${OWNER}`).execute(trx);
          for (const f of FUNCTIONS)
            await sql.raw(`ALTER FUNCTION ${f} OWNER TO ${OWNER}`).execute(trx);
          await sql.raw(`SET LOCAL ROLE ${OWNER}`).execute(trx);
        }
        const guc = (k: string, v: string) => sql`SELECT set_config(${k}, ${v}, true)`.execute(trx);
        await guc('zveltio.current_tenant', '');
        await guc('zveltio.visible_tenants', '');
        r.outside = await read(trx);
        await guc('zveltio.current_tenant', CHILD);
        r.inside = await read(trx);
        await guc('zveltio.current_tenant', ROOT);
        await sql`SET LOCAL ROLE zveltio_rls`.execute(trx);
        r.memberships = (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM zveltio_user_memberships(${USER})`.execute(trx)
        ).rows[0]?.n;
        r.share = (
          await sql<{
            t: string;
          }>`SELECT zveltio_media_share_tenant(${`${TAG}-${CHILD}`})::text AS t`.execute(trx)
        ).rows[0]?.t;
        // Not the owner: no tenant set is not a licence to read every tenant.
        await guc('zveltio.current_tenant', '');
        r.otherRole = await read(trx);
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    expect(r.outside).toEqual(
      expect.arrayContaining([...rowsOf(CHILD), ...rowsOf(PARENT).slice(3)]),
    );
    expect(r.inside).toEqual(rowsOf(CHILD).sort());
    expect(r.memberships).toBe(2);
    expect(r.share).toBe(CHILD);
    expect((r.otherRole as string[]).some((x) => x.endsWith(CHILD))).toBe(false);
  });
});

/**
 * DELETE /api/tenants/:id — archive, then purge every row the tenant owns.
 *
 * Collection tables carry `tenant_id` with no foreign key to `zv_tenants`, so
 * deleting the tenant row alone left invisible orphans. The purge must reach
 * every table with the column, leave every other tenant's rows alone, and do it
 * as the production engine does: a non-superuser that FORCE RLS binds, which
 * sees only the default tenant unless a reach is published.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getStorage } from '../../lib/storage/index.js';
import {
  applyTenantRLS,
  DEFAULT_TENANT_ID,
  getTenantSchemaName,
  provisionEnvironment,
  provisionTenantSchema,
  purgeTenant,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const COLL = `hpt_${SFX}`;
const TABLE = `zvd_${COLL}`;
// Sorts after TABLE, and references it: the first delete of TABLE hits 23503.
const REF_COLL = `hpt_${SFX}_z`;
const REF_TABLE = `zvd_${REF_COLL}`;
const OWNER = `hpt_owner_${SFX}`;

const mk = (tag: string) => ({ id: crypto.randomUUID(), slug: `hpt-${tag}-${SFX}` });
const A = mk('a'); // purged through the route
const B = mk('b'); // bystander
const P = mk('p'); // parent with a child
const Q = mk('q'); // P's child
const O = mk('o'); // purged by the non-superuser owner

d('tenant archive + purge', () => {
  let app: Hono;
  let db: Database;
  let owner: Database;
  let god = '';
  let userId = '';

  const seed = async (tenantId: string, n: number) => {
    await sql`
      INSERT INTO ${sql.id(TABLE)} (title, tenant_id)
      SELECT 'r' || g, ${tenantId}::uuid FROM generate_series(1, ${n}::int) g
    `.execute(db);
    await sql`
      INSERT INTO ${sql.id(REF_TABLE)} (title, parent, tenant_id)
      SELECT 'x', id, tenant_id FROM ${sql.id(TABLE)} WHERE tenant_id = ${tenantId}::uuid LIMIT 1
    `.execute(db);
    await sql`
      INSERT INTO zv_saved_queries (name, collection, tenant_id) VALUES ('q', ${COLL}, ${tenantId})
    `.execute(db);
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, 'member')
      ON CONFLICT DO NOTHING
    `.execute(db);
  };

  /** Rows carrying `tenantId`, per table, over EVERY table with the column. */
  const rowsOf = async (tenantId: string) => {
    const tables = await sql<{ t: string }>`
      SELECT table_name AS t FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY 1
    `.execute(db);
    const out: Record<string, number> = {};
    for (const { t } of tables.rows) {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.id(t)} WHERE tenant_id::text = ${tenantId}
      `.execute(db);
      if (r.rows[0]?.n) out[t] = r.rows[0].n;
    }
    return out;
  };

  const del = (id: string, q: string, cookie = god) =>
    app.request(`/api/tenants/${id}?${q}`, { method: 'DELETE', headers: { cookie } });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    userId = (await createMemberSession(app, db)).userId;

    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    await DDLManager.createCollection(db, {
      name: REF_COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, REF_TABLE);
    await sql`ALTER TABLE ${sql.id(REF_TABLE)} ADD COLUMN parent UUID REFERENCES ${sql.id(TABLE)}(id)`.execute(
      db,
    );

    for (const t of [A, B, P, O]) {
      await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${t.id}, ${t.slug}, 'hpt')`.execute(
        db,
      );
    }
    await sql`INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES (${Q.id}, ${Q.slug}, 'hpt', ${P.id})`.execute(
      db,
    );
    for (const [t, n] of [
      [A, 5],
      [B, 7],
      [O, 4],
      [DEFAULT_TENANT_ID, 3],
    ] as const) {
      await seed(typeof t === 'string' ? t : t.id, n);
    }
    // A's schemas and environment, and one media object on disk.
    await provisionTenantSchema(getTenantSchemaName(A.slug));
    await provisionEnvironment(A.id, A.slug, 'prod', 'Production', true);
    await getStorage().put(`uploads/hpt/${SFX}.txt`, new TextEncoder().encode('a'));
    await sql`
      INSERT INTO zv_media_files (filename, original_name, mimetype, storage_path, tenant_id)
      VALUES ('f', 'f', 'text/plain', ${`uploads/hpt/${SFX}.txt`}, ${A.id})
    `.execute(db);

    // The production shape: a plain role that FORCE RLS binds, owning the collection.
    await sql.raw(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'hpt' NOSUPERUSER NOBYPASSRLS`).execute(db);
    await sql.raw(`GRANT USAGE ON SCHEMA public TO ${OWNER}`).execute(db);
    await sql
      .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`)
      .execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} OWNER TO ${OWNER}`).execute(db);
    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = OWNER;
    url.password = 'hpt';
    owner = createDb(url.toString());
  });

  afterAll(async () => {
    if (!db) return;
    await owner?.destroy().catch(() => {});
    await sql
      .raw(`REASSIGN OWNED BY ${OWNER} TO CURRENT_USER`)
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP OWNED BY ${OWNER}`)
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP ROLE IF EXISTS ${OWNER}`)
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, REF_COLL).catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
    const ids = [A, B, P, Q, O].map((t) => t.id);
    for (const id of ids) {
      await sql`DELETE FROM zv_saved_queries WHERE tenant_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${Q.id}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ANY (${ids})`.execute(db).catch(() => {});
  });

  it('refuses anyone but god — an instance admin included', async () => {
    const admin = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
    });
    // The gate the other tenant routes use lets this user through.
    expect((await app.request('/api/tenants', { headers: { cookie: admin.cookie } })).status).toBe(
      200,
    );
    const res = await del(A.id, 'mode=archive', admin.cookie);
    expect(res.status).toBe(403);
    const t = await sql<{
      status: string;
    }>`SELECT status FROM zv_tenants WHERE id = ${A.id}`.execute(db);
    expect(t.rows[0]?.status).toBe('active');
  }, 60_000);

  it('never archives or purges the default tenant', async () => {
    expect((await del(DEFAULT_TENANT_ID, 'mode=archive')).status).toBe(409);
    expect((await del(DEFAULT_TENANT_ID, 'mode=purge&confirm=default')).status).toBe(409);
  }, 60_000);

  it('refuses to purge a tenant that was not archived first', async () => {
    const before = await rowsOf(A.id);
    const res = await del(A.id, `mode=purge&confirm=${A.slug}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/archive it first/i);
    expect(await rowsOf(A.id)).toEqual(before);
  }, 60_000);

  it('archive blocks access, keeps the data, and is idempotent', async () => {
    const before = await rowsOf(A.id);
    expect(
      (await app.request('/api/health', { headers: { 'x-tenant-slug': A.slug } })).status,
    ).toBe(200);
    for (let i = 0; i < 2; i++) {
      const res = await del(A.id, 'mode=archive');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tenant: { status: string } }).tenant.status).toBe('deleted');
    }
    const blocked = await app.request('/api/me', {
      headers: { cookie: god, 'x-tenant-slug': A.slug },
    });
    expect(blocked.status).not.toBe(200);
    expect([403, 404]).toContain(blocked.status);
    expect(await rowsOf(A.id)).toEqual(before);
  }, 60_000);

  it('refuses a purge whose confirm is not the slug', async () => {
    const before = await rowsOf(A.id);
    expect((await del(A.id, 'mode=purge&confirm=wrong')).status).toBe(400);
    expect((await del(A.id, 'mode=purge')).status).toBe(400);
    expect(await rowsOf(A.id)).toEqual(before);
  }, 60_000);

  it('archives a parent without touching its child, and refuses to purge it', async () => {
    const res = await del(P.id, 'mode=archive');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { child_tenants: { slug: string; status: string }[] };
    expect(body.child_tenants).toEqual([{ id: Q.id, slug: Q.slug, status: 'active' }] as never);
    const purge = await del(P.id, `mode=purge&confirm=${P.slug}`);
    expect(purge.status).toBe(409);
    expect(((await purge.json()) as { detail: string }).detail).toContain(Q.slug);
    const left = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM zv_tenants WHERE id = ${P.id}`.execute(db);
    expect(left.rows[0]?.n).toBe(1);
  }, 60_000);

  it('refuses when another tenant’s row points at one of the target’s rows', async () => {
    const before = await rowsOf(A.id);
    const x = await sql<{ id: string }>`
      INSERT INTO ${sql.id(REF_TABLE)} (title, parent, tenant_id)
      SELECT 'cross', id, ${B.id}::uuid FROM ${sql.id(TABLE)} WHERE tenant_id = ${A.id}::uuid LIMIT 1
      RETURNING id
    `.execute(db);
    const res = await del(A.id, `mode=purge&confirm=${A.slug}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain(REF_TABLE);
    expect(await rowsOf(A.id)).toEqual(before);
    await sql`DELETE FROM ${sql.id(REF_TABLE)} WHERE id = ${x.rows[0]?.id}`.execute(db);
  }, 60_000);

  it('purges every row of the target and nothing of anyone else', async () => {
    const others = {
      b: await rowsOf(B.id),
      def: await rowsOf(DEFAULT_TENANT_ID),
      o: await rowsOf(O.id),
    };
    const envSchema = `tenant_${A.slug.replace(/-/g, '_')}_prod`;

    const res = await del(A.id, `mode=purge&confirm=${A.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: Record<string, number>;
      files: { deleted: number; failed: string[] };
      dropped_schemas: string[];
    };
    expect(body.deleted[TABLE]).toBe(5);
    expect(body.deleted[REF_TABLE]).toBe(1);
    expect(body.deleted.zv_media_files).toBe(1);
    expect(body.deleted.zv_environments).toBe(1);
    expect(body.files).toEqual({ deleted: 1, failed: [] });
    expect(body.dropped_schemas.sort()).toEqual([getTenantSchemaName(A.slug), envSchema].sort());

    expect(await rowsOf(A.id)).toEqual({});
    const gone = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM zv_tenants WHERE id = ${A.id}`.execute(db);
    expect(gone.rows[0]?.n).toBe(0);
    const schemas = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ANY (${body.dropped_schemas})
    `.execute(db);
    expect(schemas.rows[0]?.n).toBe(0);
    expect(await getStorage().get(`uploads/hpt/${SFX}.txt`)).toBeNull();
    expect(await rowsOf(B.id)).toEqual(others.b);
    expect(await rowsOf(DEFAULT_TENANT_ID)).toEqual(others.def);
    expect(await rowsOf(O.id)).toEqual(others.o);

    const audit = await sql<{ m: { deleted: Record<string, number> } }>`
      SELECT metadata AS m FROM zv_audit_log
       WHERE event_type = 'tenant.purged' AND resource_id = ${A.id}
    `.execute(db);
    expect(audit.rows[0]?.m.deleted[TABLE]).toBe(5);
  }, 60_000);

  it('reaches every tenant’s rows as a NOSUPERUSER NOBYPASSRLS role under FORCE RLS', async () => {
    // Without a published reach this role reads the default tenant only.
    const blind = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(TABLE)} WHERE tenant_id = ${O.id}::uuid
    `.execute(owner);
    expect(blind.rows[0]?.n).toBe(0);

    await sql`UPDATE zv_tenants SET status = 'deleted' WHERE id = ${O.id}`.execute(db);

    // The reference check must see the OTHER tenant's row, which this role
    // cannot either unless every tenant is published.
    const x = await sql<{ id: string }>`
      INSERT INTO ${sql.id(REF_TABLE)} (title, parent, tenant_id)
      SELECT 'cross', id, ${B.id}::uuid FROM ${sql.id(TABLE)} WHERE tenant_id = ${O.id}::uuid LIMIT 1
      RETURNING id
    `.execute(db);
    await expect(purgeTenant(owner, O.id, O.slug)).rejects.toThrow(/other tenants/);
    await sql`DELETE FROM ${sql.id(REF_TABLE)} WHERE id = ${x.rows[0]?.id}`.execute(db);

    // After the cleanup above, which leaves B a sync tombstone of its own.
    const others = { b: await rowsOf(B.id), def: await rowsOf(DEFAULT_TENANT_ID) };
    const result = await purgeTenant(owner, O.id, O.slug);

    expect(result.deleted[TABLE]).toBe(4);
    expect(result.deleted[REF_TABLE]).toBe(1);
    expect(result.deleted.zv_saved_queries).toBe(1);
    expect(await rowsOf(O.id)).toEqual({});
    expect(await rowsOf(B.id)).toEqual(others.b);
    expect(await rowsOf(DEFAULT_TENANT_ID)).toEqual(others.def);
  }, 60_000);
});

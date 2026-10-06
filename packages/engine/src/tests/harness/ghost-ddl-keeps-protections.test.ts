/**
 * A ghost migration must hand back a table with everything the original had
 * around its rows, not only the rows.
 *
 * The ghost is built with `CREATE TABLE … (LIKE … INCLUDING ALL)`, which copies
 * columns, defaults, CHECKs and indexes — and nothing else. Swapped in as-is it
 * came back without its triggers (sync tombstones, `updated_at`, FTS), without
 * RLS enabled or forced and without its tenant policies, with default grants in
 * place of the table's own, without its outbound foreign keys, and with every
 * inbound foreign key still pointing at the renamed old copy.
 *
 * Driven through the real caller: a schema-branch merge on a collection above
 * the 100 000-row threshold, which is the only road into `GhostDDL.execute`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { applyTenantRLS } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const TARGET = `hgp_tgt_${SFX}`;
const MAIN = `hgp_${SFX}`;
const REFERRER = `hgp_ref_${SFX}`;
const TABLE = `zvd_${MAIN}`;

/** Everything about `table` a ghost swap must carry over, in comparable form. */
async function protections(db: Database, table: string) {
  const r = await sql<{ p: Record<string, unknown> }>`
    SELECT json_build_object(
      'owner', pg_get_userbyid(c.relowner),
      'rls', c.relrowsecurity,
      'force', c.relforcerowsecurity,
      'acl', (SELECT array_agg(a.grantee::regrole::text || ':' || a.privilege_type)
              FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a),
      'triggers', (SELECT array_agg(t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid))
                   FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal),
      'policies', (SELECT array_agg(p.policyname || ' ' || p.permissive || ' ' || p.cmd || ' '
                                    || p.roles::text || ' ' || coalesce(p.qual, '-') || ' '
                                    || coalesce(p.with_check, '-'))
                   FROM pg_policies p
                   WHERE p.schemaname = current_schema() AND p.tablename = c.relname),
      'fks', (SELECT array_agg(k.conrelid::regclass::text || ' ' || k.conname || ' '
                               || pg_get_constraintdef(k.oid))
              FROM pg_constraint k
              WHERE k.contype = 'f' AND (k.conrelid = c.oid OR k.confrelid = c.oid))
    ) AS p
    FROM pg_class c WHERE c.oid = ${table}::regclass
  `.execute(db);
  const p = r.rows[0]?.p as {
    owner: string;
    rls: boolean;
    force: boolean;
    acl: string[];
    triggers: string[];
    policies: string[];
    fks: string[];
  };
  // Catalog order is creation order, which a faithful copy need not repeat.
  for (const k of ['acl', 'triggers', 'policies', 'fks'] as const) p[k] = (p[k] ?? []).sort();
  return p;
}

d('ghost DDL keeps triggers, RLS, policies, grants and foreign keys', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const merge = async (type: 'add_field' | 'remove_field', payload: Record<string, unknown>) => {
    const created = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `hgp-${type}-${SFX}` }),
    });
    expect(created.status).toBe(201);
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    const change = await app.request(`/api/schema/branches/${branch.id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type, payload }),
    });
    expect(change.status).toBeLessThan(300);
    const res = await app.request(`/api/schema/branches/${branch.id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    const body = (await res.json()) as { errors: string[] };
    await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    return body;
  };

  const text = { type: 'text', required: false, unique: false, indexed: false };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    await DDLManager.createCollection(db, {
      name: TARGET,
      fields: [{ name: 'label', ...text }],
    } as never);
    await DDLManager.createCollection(db, {
      name: MAIN,
      fields: [
        { name: 'title', ...text },
        { name: 'owner_ref', ...text, type: 'm2o', options: { related_collection: TARGET } },
      ],
    } as never);
    await DDLManager.createCollection(db, {
      name: REFERRER,
      fields: [
        { name: 'label', ...text },
        { name: 'main_ref', ...text, type: 'm2o', options: { related_collection: MAIN } },
      ],
    } as never);
    // What the create_collection job does after createCollection (ddl-queue.ts).
    await applyTenantRLS(db, TABLE);
    // A restrictive policy scoped to one role, and a grant narrower than the
    // default privileges a freshly created ghost receives.
    await sql`
      CREATE POLICY hgp_restrict ON ${sql.id(TABLE)} AS RESTRICTIVE FOR SELECT TO zveltio_rls
      USING (title IS DISTINCT FROM 'hidden')
    `.execute(db);
    await sql`REVOKE DELETE ON ${sql.id(TABLE)} FROM zveltio_rls`.execute(db);

    // Past the 100 000-row threshold, so the merge takes the Ghost DDL road.
    await sql`
      INSERT INTO ${sql.id(TABLE)} (title) SELECT 'r' || g FROM generate_series(1, 100001) g
    `.execute(db);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    for (const name of [REFERRER, MAIN, TARGET]) {
      await sql`DROP TABLE IF EXISTS ${sql.id(`zvd_${name}`)} CASCADE`.execute(db).catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await sweepGhostOrphans(db);
  });

  it('an added column leaves every protection of the table as it was', async () => {
    const before = await protections(db, TABLE);
    // The fixture really has what the assertions below are about.
    expect(before.triggers.some((t) => t.includes('zv_sync_tombstone'))).toBe(true);
    // Tenant isolation, the row rules, and one collection-permission policy per
    // command (R1).
    expect(before.policies.length).toBe(6);
    expect(before.rls && before.force).toBe(true);
    expect(before.fks.length).toBe(4); // created_by, updated_by, owner_ref, and the referrer's

    const body = await merge('add_field', {
      collection: MAIN,
      field: { name: 'note', type: 'text', required: false, unique: false, indexed: false },
    });
    expect(body.errors).toEqual([]);
    const ghostRan = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ${`_zv_old_${TABLE}`}
    `.execute(db);
    expect(ghostRan.rows[0]?.n).toBe(1);

    expect(await protections(db, TABLE)).toEqual(before);
  }, 120_000);

  it('the old copy is no longer pinned by the inbound foreign key', async () => {
    // What the 60 s timer does; the inbound FK left on the old copy made it fail.
    cancelPendingCleanups();
    const swept = await sweepGhostOrphans(db);
    expect(swept.failed).toEqual([]);
    expect(swept.dropped).toContain(`_zv_old_${TABLE}`);
  });

  // Straight to GhostDDL: the merge route only ever sends ADD and DROP COLUMN.
  it('a renamed relation column keeps its foreign key, under the new name', async () => {
    const before = await protections(db, TABLE);
    await GhostDDL.execute(db, TABLE, [
      { kind: 'rename_column', from: 'owner_ref', to: 'owner_link' },
    ]);
    cancelPendingCleanups();
    await sweepGhostOrphans(db);

    expect(await protections(db, TABLE)).toEqual({
      ...before,
      fks: before.fks.map((f) => f.replace('KEY (owner_ref)', 'KEY (owner_link)')),
    });
  }, 120_000);

  it('a change a policy cannot follow aborts the swap instead of shedding the policy', async () => {
    const before = await protections(db, TABLE);
    // hgp_restrict reads `title`; recreated on the renamed ghost it cannot resolve.
    await expect(
      GhostDDL.execute(db, TABLE, [{ kind: 'rename_column', from: 'title', to: 'headline' }]),
    ).rejects.toThrow(/title/);

    expect(await protections(db, TABLE)).toEqual(before);
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE tablename IN (${`_zv_ghost_${TABLE}`}, ${`_zv_old_${TABLE}`})
    `.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  }, 120_000);
});

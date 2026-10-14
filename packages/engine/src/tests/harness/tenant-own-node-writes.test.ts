/**
 * A parent unit reads its subtree; it changes rows in its own node only (B09).
 *
 * Every tenant table carried one FOR ALL policy: USING the visible set, WITH
 * CHECK the own node. WITH CHECK sees only the new row, so a parent with
 * `subtree` reach could DELETE a child's row, and UPDATE it into its own node
 * and delete it from there. Proved here on each road that writes the policy: a
 * collection (`applyTenantRLS`), an extension table (`reconcileExtensionTenantRLS`),
 * an engine table the reconciler adopts (`zv_sync_tombstones`), and the audit log.
 * The engine's own cross-firm purge, which runs with no tenant set, still reaches
 * every firm.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { runGarbageCollector } from '../../lib/runtime/garbage-collector.js';
import {
  applyTenantRLS,
  reconcileExtensionTenantRLS,
  withTenantIsolation,
} from '../../lib/tenancy/tenant-manager.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const PARENT = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const TAG = `b09-${Date.now()}`;
const USER = `${TAG}-user`;
const COLLECTION = `zvd_b09_probe_${Date.now()}`;
const EXT = `zv_b09_ext_probe_${Date.now()}`;

d('UPDATE and DELETE stay in the own node (B09)', () => {
  let db: Database;

  const asParent = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(PARENT, fn, { userId: USER });
  /** Move every row into the parent's node, then delete every row: both must miss. */
  const takeAndDelete = (table: string, where = sql`true`) =>
    asParent(async (trx) => {
      const n = async (q: ReturnType<typeof sql>) =>
        Number((await q.execute(trx)).numAffectedRows ?? 0n);
      return [
        await n(sql`UPDATE ${sql.id(table)} SET tenant_id = ${PARENT}::uuid WHERE ${where}`),
        await n(sql`DELETE FROM ${sql.id(table)} WHERE ${where}`),
      ];
    });
  const count = async (table: string) =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(table)}
                                WHERE tenant_id = ${CHILD}::uuid`.execute(trx),
      )
    ).rows[0]?.n;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status) VALUES
                (${PARENT}::uuid, ${`${TAG}-p`}, ${`${TAG}-p`}, 'active')`.execute(db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status, parent_id) VALUES
                (${CHILD}::uuid, ${`${TAG}-c`}, ${`${TAG}-c`}, 'active', ${PARENT}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO "user" (id, name, email) VALUES (${USER}, ${USER}, ${`${USER}@test.local`})`.execute(
      db,
    );
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope)
              VALUES (${PARENT}::uuid, ${USER}, 'admin', 'subtree')`.execute(db);

    await sql
      .raw(
        `CREATE TABLE ${COLLECTION} (id serial primary key, tenant_id uuid NOT NULL, label text)`,
      )
      .execute(db);
    await applyTenantRLS(db, COLLECTION);
    // An extension's template policy, as sloppy as the ones the reconciler exists for.
    await sql
      .raw(`CREATE TABLE ${EXT} (id serial primary key, tenant_id uuid NOT NULL, label text)`)
      .execute(db);
    await sql.raw(`CREATE POLICY tenant_isolation_${EXT} ON ${EXT} USING (true)`).execute(db);
    expect(await reconcileExtensionTenantRLS(db, [EXT])).toBe(1);
    for (const t of [COLLECTION, EXT]) {
      await sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO zveltio_rls`).execute(db);
      await sql.raw(`GRANT USAGE ON SEQUENCE ${t}_id_seq TO zveltio_rls`).execute(db);
      await asTenant(db, CHILD, (trx) =>
        sql
          .raw(`INSERT INTO ${t} (tenant_id, label) VALUES ('${CHILD}', 'child-row')`)
          .execute(trx),
      );
    }
    // As shipped after the boot reconcile, which is what every install runs.
    await reconcileExtensionTenantRLS(db, ['zv_sync_tombstones']);
    await asTenant(db, CHILD, (trx) =>
      sql`INSERT INTO zv_sync_tombstones (tenant_id, collection, row_id, deleted_at) VALUES
                (${CHILD}::uuid, ${TAG}, gen_random_uuid(), now()),
                (${CHILD}::uuid, ${TAG}, gen_random_uuid(), now() - interval '90 days')`.execute(
        trx,
      ),
    );
    await asTenant(db, CHILD, (trx) =>
      sql`INSERT INTO zv_audit_log (event_type, tenant_id) VALUES (${TAG}, ${CHILD}::uuid)`.execute(
        trx,
      ),
    );
  });

  afterAll(async () => {
    for (const t of [COLLECTION, EXT]) {
      await sql
        .raw(`DROP TABLE IF EXISTS ${t}`)
        .execute(db)
        .catch(() => undefined);
    }
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_sync_tombstones WHERE collection = ${TAG}`.execute(trx),
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = ${TAG}`.execute(trx),
    );
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ${USER}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${CHILD}::uuid, ${PARENT}::uuid)`.execute(db);
  });

  it.each([COLLECTION, EXT])("the parent reads %s's child row and cannot take it", async (t) => {
    const seen = await asParent(
      async (trx) =>
        (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(t)}`.execute(trx)).rows[0]
          ?.n,
    );
    expect(seen).toBe(1);
    expect(await takeAndDelete(t)).toEqual([0, 0]);
    expect(await count(t)).toBe(1);
  });

  it("the parent cannot take the child's tombstones or audit rows", async () => {
    expect(await takeAndDelete('zv_sync_tombstones', sql`collection = ${TAG}`)).toEqual([0, 0]);
    expect(await takeAndDelete('zv_audit_log', sql`event_type = ${TAG}`)).toEqual([0, 0]);
    expect(await count('zv_sync_tombstones')).toBe(2);
    expect(await count('zv_audit_log')).toBe(1);
  });

  it("the child deletes its own rows, and the engine's purge still reaches every firm", async () => {
    const own = await withTenantIsolation(CHILD, async (trx) =>
      Number((await sql`DELETE FROM ${sql.id(EXT)}`.execute(trx)).numAffectedRows ?? 0n),
    );
    expect(own).toBe(1);
    // No tenant set, every firm published (`withEveryTenant`): the retention purge.
    await runGarbageCollector(db);
    const left = await asEveryTenant(db, (trx) =>
      sql<{ old: boolean }>`
      SELECT deleted_at < now() - interval '1 day' AS old
        FROM zv_sync_tombstones WHERE collection = ${TAG}`.execute(trx),
    );
    expect(left.rows).toEqual([{ old: false }]);
  });
});

/**
 * A moved row rule stops enforcing where it left — under concurrency, and on a
 * table with no `zvd_collections` row.
 *
 * `updateRlsPolicy` rebuilds the policy of the collection a rule leaves. It
 * read that collection in a statement of its own before the UPDATE, so a move
 * that committed between the two was invisible: the second move rebuilt the
 * collection the rule had been in before the first, and the one it was really
 * leaving kept a `zv_row_rules` predicate built from it.
 *
 * And a `*` rule change rebuilds through `reconcileRowRulePolicies`, which
 * listed tables only through `zvd_collections` — so a table without a row there
 * kept the moved `*` rule in its policy for good, restarts included.
 */

import { afterAll, beforeAll, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { applyRowRulePolicy } from '../../lib/tenancy/index.js';
import { createRlsPolicy, deleteRlsPolicy, updateRlsPolicy } from '../../lib/tenancy/rls.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const t = harnessAvailable() ? it : it.skip;
const STAMP = `${Date.now()}`;
const [A, B, C, ORPH] = ['a', 'b', 'c', 'orph'].map((s) => `rulemove_${s}_${STAMP}`);
const ROLE = `nobody_${STAMP}`;
let db: Database;
const ids: string[] = [];

/** The `zv_row_rules` predicate on a collection's table, or null when it has none. */
const policyOn = async (coll: string): Promise<string | null> =>
  (
    await sql<{ qual: string }>`
      SELECT qual FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ${`zvd_${coll}`} AND policyname = 'zv_row_rules'`.execute(
      db,
    )
  ).rows[0]?.qual ?? null;

async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (r.rows[0]!.n > 0) return;
    await Bun.sleep(25);
  }
  throw new Error('no statement ever waited on the lock');
}

beforeAll(async () => {
  if (!harnessAvailable()) return;
  ({ db } = await getTestApp());
  for (const coll of [A, B, C, ORPH]) {
    await sql.raw(`CREATE TABLE zvd_${coll} (id uuid PRIMARY KEY, created_by text)`).execute(db);
    await sql.raw(`ALTER TABLE zvd_${coll} ENABLE ROW LEVEL SECURITY`).execute(db);
  }
  // ORPH alone has no zvd_collections row.
  for (const coll of [A, B, C]) {
    await sql`INSERT INTO zvd_collections (name, display_name) VALUES (${coll}, ${coll})`.execute(
      db,
    );
  }
});

afterAll(async () => {
  if (!db) return;
  await sql`DELETE FROM zvd_rls_policies WHERE id = ANY(${sql.val(ids)}::uuid[])`.execute(db);
  for (const coll of [A, B, C, ORPH]) {
    await sql.raw(`DROP TABLE IF EXISTS zvd_${coll} CASCADE`).execute(db);
  }
  await sql`DELETE FROM zvd_collections WHERE name = ANY(${sql.val([A, B, C])}::text[])`.execute(
    db,
  );
});

t('a move that commits under another move is the one the second move rebuilds', async () => {
  const rule = await createRlsPolicy({
    collection: A,
    role: '*',
    filter_field: 'created_by',
    filter_op: 'eq',
    filter_value_source: 'user_id',
  });
  ids.push(rule.id);
  expect(await policyOn(A)).not.toBeNull();

  // Move one, A -> B, held open with B's policy already rebuilt — exactly where
  // its own after-commit refresh would leave it.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let moved!: () => void;
  const movedToB = new Promise<void>((r) => {
    moved = r;
  });
  const first = db.transaction().execute(async (trx) => {
    await sql`UPDATE zvd_rls_policies SET collection = ${B} WHERE id = ${rule.id}`.execute(trx);
    await applyRowRulePolicy(trx, B);
    moved();
    await gate;
  });
  await movedToB;

  // Move two, to C, starts while move one is still open and finishes after it.
  const second = updateRlsPolicy(rule.id, { collection: C });
  await waitForLockWaiter();
  release();
  await first;
  expect((await second)?.collection).toBe(C);

  // The rule is in C; B, which it left last, enforces nothing.
  expect(await policyOn(C)).not.toBeNull();
  expect(await policyOn(B)).toBeNull();
  await deleteRlsPolicy(rule.id);
});

t('a `*` rule moved away stops enforcing on a table with no zvd_collections row', async () => {
  // Its own rule puts a policy on the table, and that policy carries every
  // `*` rule too. The `*` rule is scoped to a role nobody holds so the other
  // collections in this database are not touched in effect.
  const star = await createRlsPolicy({
    collection: '*',
    role: ROLE,
    filter_field: 'created_by',
    filter_op: 'eq',
    filter_value_source: 'user_id',
  });
  ids.push(star.id);
  const own = await createRlsPolicy({
    collection: ORPH,
    role: '*',
    filter_field: 'created_by',
    filter_op: 'neq',
    filter_value_source: 'static:x',
  });
  ids.push(own.id);
  expect(await policyOn(ORPH)).toContain(ROLE);

  await updateRlsPolicy(star.id, { collection: A });
  const after = await policyOn(ORPH);
  expect(after).not.toBeNull();
  expect(after).not.toContain(ROLE);
});

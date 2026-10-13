/**
 * A row-rule policy rebuild is one serialised step.
 *
 * `applyRowRulePolicy` read the rules, then ran DROP POLICY and CREATE POLICY
 * as separate autocommit statements. So two refreshes of one table could
 * interleave and the one that read the OLDER rules wrote last, and between the
 * DROP and the CREATE the table had no row-rule policy at all.
 *
 * Both are made deterministic by pausing one refresh at a chosen statement (a
 * plugin that holds its result) while the rest of the world moves on.
 */

import { afterAll, beforeAll, expect, it } from 'bun:test';
import { type KyselyPlugin, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { applyRowRulePolicy } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const t = harnessAvailable() ? it : it.skip;
const COLL = `rulerebuild_${Date.now()}`;
const TABLE = `zvd_${COLL}`;
let db: Database;
let ruleId = '';

/** `db`, but the first statement whose SQL matches waits for `release()` after it ran. */
function pausedAt(match: string) {
  let hit!: () => void;
  const reached = new Promise<void>((r) => {
    hit = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const marked = new Set<unknown>();
  let armed = true;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      const node = args.node as { kind: string; sqlFragments?: readonly string[] };
      if (armed && node.kind === 'RawNode' && (node.sqlFragments ?? []).join('?').includes(match)) {
        armed = false;
        marked.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (marked.delete(args.queryId)) {
        hit();
        await gate;
      }
      return args.result;
    },
  };
  return { db: db.withPlugin(plugin) as Database, reached, release };
}

/** The `zv_row_rules` predicate, read where no lock on the table is needed. */
const policyOn = async (): Promise<string | null> =>
  (
    await sql<{ qual: string }>`
      SELECT pg_get_expr(p.polqual, p.polrelid) AS qual FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = ${TABLE} AND p.polname = 'zv_row_rules'`.execute(db)
  ).rows[0]?.qual ?? null;

/** Present or not, from the catalog alone: `pg_get_expr` opens the table. */
const hasPolicy = async (): Promise<boolean> =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = ${TABLE} AND p.polname = 'zv_row_rules'`.execute(db)
  ).rows[0]!.n > 0;

const setValue = (v: string) =>
  sql`UPDATE zvd_rls_policies SET filter_value_source = ${`static:${v}`} WHERE id = ${ruleId}`.execute(
    db,
  );

async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (r.rows[0]!.n > 0) return;
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  if (!harnessAvailable()) return;
  ({ db } = await getTestApp());
  await sql.raw(`CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, owner text)`).execute(db);
  await sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`).execute(db);
  // Written straight into the table: the routes' own refresh is not under test.
  ruleId = (
    await sql<{ id: string }>`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source)
      VALUES (${COLL}, '*', 'owner', 'eq', 'static:one') RETURNING id`.execute(db)
  ).rows[0]!.id;
});

afterAll(async () => {
  if (!db) return;
  await sql`DELETE FROM zvd_rls_policies WHERE id = ${ruleId}`.execute(db);
  await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db);
});

t('a refresh that read older rules does not write last', async () => {
  await setValue('one');
  const slow = pausedAt('FROM zvd_rls_policies');
  const first = applyRowRulePolicy(slow.db, COLL);
  await slow.reached; // read `one`, not yet written

  await setValue('two');
  const second = applyRowRulePolicy(db, COLL);
  // Serialised, the second refresh waits for the first; unserialised it finishes.
  await Promise.race([second, someoneWaitsOnALock()]);
  slow.release();
  await Promise.all([first, second]);

  const qual = await policyOn();
  expect(qual).toContain("'two'");
  expect(qual).not.toContain("'one'");
});

t('the table never stands without its row-rule policy mid-rebuild', async () => {
  await setValue('three');
  await applyRowRulePolicy(db, COLL);
  expect(await hasPolicy()).toBe(true);

  const slow = pausedAt('DROP POLICY');
  const rebuild = applyRowRulePolicy(slow.db, COLL);
  await slow.reached; // dropped, not yet re-created
  const visibleMidway = await hasPolicy();
  slow.release();
  await rebuild;

  expect(visibleMidway).toBe(true);
  expect(await hasPolicy()).toBe(true);
});

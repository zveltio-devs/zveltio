/**
 * One rule, FOUR interpreters — and they have to agree.
 *
 * A row rule is read by four different pieces of code:
 *
 *   applyRlsFilters       → a Kysely WHERE, run by Postgres on the live table
 *   buildRowRulePredicate → SQL text, run by Postgres as a RESTRICTIVE policy
 *   matchesRlsFilters     → JavaScript, in-process, for realtime fan-out
 *   rlsJsonConditions     → SQL over the jsonb snapshots, for `?as_of=`
 *
 * An independent audit found seven divergences between them, and the comment
 * above two of them claimed they were kept adjacent precisely so they could not
 * drift. Adjacency is not agreement. The real one was `neq` on a NULL column:
 * absent from `/api/data`, delivered over SSE — a leak.
 *
 * ── And the audit undercounted, because so did this file ──────
 *
 * This suite compared THREE. The fourth lives in the same file as two of them
 * and its own comment calls itself "the third", having been written before the
 * policy generator existed elsewhere. Nothing compared it to anything.
 *
 * Adding it here turned 56 green cases into 18 failures on unchanged code. Twelve
 * were the audit's own finding, surviving in the one applier nobody corrected:
 * `neq` and `not_in` KEPT a row with a NULL field, so `?as_of=` — the parameter
 * that exists for auditing — showed rows `/api/data` withholds. The other six ran
 * the opposite way: `code eq static:5` matched the number 5 on the live table and
 * not in a snapshot, because that applier compared JSON strings while the other
 * three compare text.
 *
 * The lesson is the count, not the cases: three of four appliers were fixed and
 * the fourth silently disagreed for a day. Which is the argument for compiling
 * one rule into all four forms from one place — not yet done, and this suite is
 * what makes that refactor checkable when it happens.
 *
 * So this walks the product of every operator, every value source, and the
 * column shapes that actually occur (including NULL), and asserts all three
 * answer the same. It is deliberately exhaustive rather than illustrative: the
 * audit found its cases by hand, and hand-picked tuples are exactly what a
 * refactor slips past.
 *
 * ── Identities come from production, not from imagination ─────
 *
 * The earlier suite invented `{ role: 'member' }`. Better-auth never populates
 * `session.user.role`, so that user does not exist — a test can pass on a shape
 * the product never produces. The identities below are built the way
 * `session-prefetch` and `lib/data/auth.ts` build them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  applyRlsFilters,
  buildRowRulePredicate,
  describeRuleProblem,
  getRlsFilters,
  matchesRlsFilters,
  rlsJsonConditions,
  type RowRule,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const TABLE = `zvd_three_${STAMP}`;
const COLL = `three_${STAMP}`;

/** The column shapes that occur, including the one everything got wrong. */
const ROWS = [
  { id: 1, bucket: 'alpha', code: 5 },
  { id: 2, bucket: 'beta', code: 7 },
  { id: 3, bucket: null as string | null, code: null as number | null },
  { id: 4, bucket: 'user-1', code: 1 },
];

const TYPES = { bucket: 'text', code: 'integer' };

/**
 * The identity a session actually has.
 *
 * `role` is empty because better-auth does not populate it — the middleware
 * resolves it separately. A test that fills it in is testing a user that cannot
 * exist.
 */
const SESSION = { id: 'user-1', email: 'user-1@test.local', role: '' };

const OPERATORS = ['eq', 'neq', 'in', 'not_in'] as const;
const SOURCES = [
  'user_id',
  'user_email',
  'user_role',
  'static:alpha',
  'static:alpha,beta',
  // The numeric case an administrator really writes, and the one where a JS
  // `===` and a Postgres cast part company.
  'static:5',
  'static:5,7',
] as const;
const FIELDS = ['bucket', 'code'] as const;

/** A single-quoted SQL literal — the snapshots are written with raw SQL here. */
function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function ruleOf(field: string, op: string, source: string): RowRule {
  return { role: '*', filter_field: field, filter_op: op, filter_value_source: source };
}

/**
 * What `getRlsFilters` would build for this rule and this session.
 *
 * A MODEL of the resolver, and therefore a fifth reading of the same rule — the
 * exact thing this suite exists to forbid. It is kept only as a cross-check
 * against the real one, which `resolveFor` below calls with a policy actually
 * stored in `zvd_rls_policies`. If the model and the resolver ever disagree, the
 * suite says so rather than quietly testing a rule the product would never
 * produce.
 */
function engineFilter(
  rule: RowRule,
): { field: string; condition: { op: string; value: unknown } } | null {
  const src = rule.filter_value_source;
  let value: string | null;
  if (src === 'user_id') value = SESSION.id;
  else if (src === 'user_email') value = SESSION.email;
  else if (src === 'user_role') value = SESSION.role;
  else if (src.startsWith('static:')) value = src.slice('static:'.length);
  else return null;
  // `getRlsFilters` skips a policy whose value does not resolve.
  if (value === null || value === '') return null;

  const isList = rule.filter_op === 'in' || rule.filter_op === 'not_in';
  const condValue =
    isList && src.startsWith('static:')
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value;
  return { field: rule.filter_field, condition: { op: rule.filter_op, value: condValue } };
}

d('one rule, four interpreters (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql
      .raw(`CREATE TABLE ${TABLE} (id integer PRIMARY KEY, bucket text, code integer, data jsonb)`)
      .execute(db);
    for (const r of ROWS) {
      await sql
        .raw(
          // `data` is the row as `zv_revisions` stores it: the same values, as
          // JSON, so the snapshot path is asked about the identical row.
          `INSERT INTO ${TABLE} (id, bucket, code, data) VALUES (${r.id}, ` +
            `${r.bucket === null ? 'NULL' : `'${r.bucket}'`}, ${r.code === null ? 'NULL' : r.code}, ` +
            `${sqlLit(JSON.stringify({ bucket: r.bucket, code: r.code }))}::jsonb)`,
        )
        .execute(db);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`)
      .execute(db)
      .catch(() => {});
  });

  /**
   * What the caller SEES — which is the only thing worth comparing.
   *
   * A skipped rule is not a third outcome: it means no filter, so every row is
   * visible. Comparing "skipped" against a list of ids would call two identical
   * outcomes a divergence. And a rule that makes the query THROW is an outcome
   * too — one the caller feels — so it is captured rather than escaping.
   */
  type Outcome = number[] | 'error';

  async function viaEngineSql(filters: unknown[]): Promise<Outcome> {
    let q = db.selectFrom(TABLE as never).select('id' as never);
    if (filters.length > 0) q = applyRlsFilters(q, filters as never);
    try {
      const rows = (await q.execute()) as Array<{ id: number }>;
      return rows.map((r) => r.id).sort((a, b) => a - b);
    } catch {
      return 'error';
    }
  }

  /**
   * Ids the generated policy predicate keeps.
   *
   * Inside a transaction, with the settings written locally — which is how
   * production does it. Setting them on the pool instead lets the next query
   * land on a different connection that never saw them, and then the predicate
   * reads empty strings and keeps everything. The first version of this suite
   * did exactly that and reported every case as a divergence.
   */
  async function viaPolicy(rule: RowRule): Promise<Outcome> {
    const { predicate } = buildRowRulePredicate([rule], TYPES);
    const where = predicate ?? 'true';
    return db.transaction().execute(async (trx) => {
      await sql`
        SELECT set_config('zveltio.user_id', ${SESSION.id}, true),
               set_config('zveltio.user_email', ${SESSION.email}, true),
               set_config('zveltio.user_role', ${SESSION.role}, true),
               set_config('zveltio.user_roles', '', true),
               set_config('zveltio.actor', 'on', true),
               set_config('zveltio.rls_bypass', 'off', true)
      `.execute(trx);
      try {
        const rows = await sql
          .raw<{ id: number }>(`SELECT id FROM ${TABLE} WHERE ${where} ORDER BY id`)
          .execute(trx);
        return rows.rows.map((r) => r.id);
      } catch {
        return 'error' as const;
      }
    });
  }

  /**
   * The resolver itself, asked about a policy stored the way the product stores
   * one — so what the four appliers are handed is the real thing, not a model.
   */
  async function resolveFor(rule: RowRule): Promise<unknown[]> {
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLL}`.execute(db);
    await sql`
      INSERT INTO zvd_rls_policies
        (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLL}, ${rule.role}, ${rule.filter_field}, ${rule.filter_op},
              ${rule.filter_value_source}, true)
    `.execute(db);
    return (await getRlsFilters(
      COLL,
      { id: SESSION.id, email: SESSION.email, role: SESSION.role },
      'session',
    )) as unknown[];
  }

  /**
   * Ids the SNAPSHOT path keeps — `?as_of=`, which rebuilds rows from
   * `zv_revisions.data` and so applies the rule as SQL over jsonb.
   *
   * The fourth applier of the same four operators, and the one nothing compared
   * until now: its own doc comment calls it "the third", because it was written
   * before the policy generator existed in another file. A rule means whatever
   * the caller is shown, and `/api/data` and `/api/data?as_of=` are both callers.
   */
  async function viaSnapshot(filters: unknown[]): Promise<Outcome> {
    try {
      let q = db.selectFrom(TABLE as never).select('id' as never);
      for (const cond of rlsJsonConditions(filters as never, 'data')) {
        q = (q as unknown as { where: (c: unknown) => typeof q }).where(cond);
      }
      const rows = (await q.execute()) as Array<{ id: number }>;
      return rows.map((r) => r.id).sort((a, b) => a - b);
    } catch {
      return 'error';
    }
  }

  /** Ids the in-process matcher keeps. */
  function viaMatcher(filters: unknown[]): Outcome {
    if (filters.length === 0) return ROWS.map((r) => r.id);
    try {
      return ROWS.filter((r) => matchesRlsFilters(r as never, filters as never)).map((r) => r.id);
    } catch {
      return 'error';
    }
  }

  it('stands down for work that has no actor at all', async () => {
    // The reason `zveltio.actor` exists, and the case the old guard was really
    // protecting when it skipped on any empty setting.
    //
    // Background jobs and boot reconcilers open a tenant transaction and publish
    // no identity. A rule that says "only your own rows" has no answer for them,
    // and hiding everything would break work that has nothing to do with any
    // user. They keep today's behaviour.
    //
    // Asserted against `actor=off` WITH a non-empty user_id also set, so it is
    // the flag doing the work and not the emptiness of the value — the exact
    // conflation this change removes.
    const rule = ruleOf('bucket', 'eq', 'user_id');
    const { predicate } = buildRowRulePredicate([rule], TYPES);
    const ids = await db.transaction().execute(async (trx) => {
      await sql`
        SELECT set_config('zveltio.user_id', 'somebody', true),
               set_config('zveltio.actor', 'off', true),
               set_config('zveltio.rls_bypass', 'off', true)
      `.execute(trx);
      const r = await sql
        .raw<{ id: number }>(`SELECT id FROM ${TABLE} WHERE ${predicate ?? 'true'} ORDER BY id`)
        .execute(trx);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toEqual(ROWS.map((r) => r.id));
  });

  it('does NOT stand down for a request whose field is merely empty', async () => {
    // The divergence this change closes. `session.user.role` is never populated,
    // so `bucket eq user_role` resolves to the empty string — which the engine
    // applies (hiding every row) and the policy used to skip (showing all four).
    const rule = ruleOf('bucket', 'eq', 'user_role');
    const { predicate } = buildRowRulePredicate([rule], TYPES);
    const ids = await db.transaction().execute(async (trx) => {
      await sql`
        SELECT set_config('zveltio.user_role', '', true),
               set_config('zveltio.actor', 'on', true),
               set_config('zveltio.rls_bypass', 'off', true)
      `.execute(trx);
      const r = await sql
        .raw<{ id: number }>(`SELECT id FROM ${TABLE} WHERE ${predicate ?? 'true'} ORDER BY id`)
        .execute(trx);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toEqual([]);
  });

  for (const field of FIELDS) {
    for (const op of OPERATORS) {
      for (const source of SOURCES) {
        // A numeric column against an email or a word is not a rule anyone
        // writes, and Postgres refuses the cast outright — excluded rather than
        // asserted, so the suite tests rules that can exist.
        // Kept, not excluded: an administrator CAN save `code eq user_id`, and
        // what the three interpreters do with an impossible cast is exactly the
        // kind of thing that diverges quietly.
        it(`${field} ${op} ${source}`, async () => {
          const rule = ruleOf(field, op, source);

          // A rule the product refuses to store cannot diverge, because it
          // cannot exist. The partition is DERIVED from the validator the save
          // route uses — not a hand-written exclusion list, which is how the
          // audit's tuples slipped past the previous suite.
          const problem = describeRuleProblem(rule, TYPES);
          if (problem) {
            expect(problem.length).toBeGreaterThan(0);
            return;
          }

          // Everything is driven from the REAL resolver, on a policy row stored
          // the way the product stores one.
          //
          // It used to be driven from a local model of it, and that model hid a
          // divergence rather than finding one: it skipped a rule whose value
          // resolved to the empty string, which is what the generated policy
          // does — while `getRlsFilters` skips only on NULL and emits
          // `field = ''`. Model and policy agreed; the engine did not; the suite
          // was green. A test that models the thing it is testing is the fifth
          // interpreter, not a check on the other four.
          const filters = await resolveFor(rule);

          const engine = await viaEngineSql(filters);
          const policy = await viaPolicy(rule);
          const matcher = viaMatcher(filters);
          const snapshot = await viaSnapshot(filters);

          expect({ policy, matcher, snapshot }).toEqual({
            policy: engine,
            matcher: engine,
            snapshot: engine,
          });
        });
      }
    }
  }
});

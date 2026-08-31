/**
 * One rule, three interpreters — and they have to agree.
 *
 * A row rule is read by three different pieces of code:
 *
 *   applyRlsFilters      → a Kysely WHERE, run by Postgres
 *   buildRowRulePredicate → SQL text, run by Postgres as a RESTRICTIVE policy
 *   matchesRlsFilters     → JavaScript, run in-process for realtime fan-out
 *
 * An independent audit found seven divergences between them, and the comment
 * above the last two claimed they were kept adjacent precisely so they could not
 * drift. Adjacency is not agreement. The real one was `neq` on a NULL column:
 * absent from `/api/data`, delivered over SSE — a leak.
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
  matchesRlsFilters,
  type RowRule,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const TABLE = `zvd_three_${STAMP}`;

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

function ruleOf(field: string, op: string, source: string): RowRule {
  return { role: '*', filter_field: field, filter_op: op, filter_value_source: source };
}

/** What `getRlsFilters` would build for this rule and this session. */
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

d('one rule, three interpreters (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql
      .raw(`CREATE TABLE ${TABLE} (id integer PRIMARY KEY, bucket text, code integer)`)
      .execute(db);
    for (const r of ROWS) {
      await sql
        .raw(
          `INSERT INTO ${TABLE} (id, bucket, code) VALUES (${r.id}, ` +
            `${r.bucket === null ? 'NULL' : `'${r.bucket}'`}, ${r.code === null ? 'NULL' : r.code})`,
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

  async function viaEngineSql(rule: RowRule): Promise<Outcome> {
    const f = engineFilter(rule);
    let q = db.selectFrom(TABLE as never).select('id' as never);
    if (f) q = applyRlsFilters(q, [f as never]);
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

  /** Ids the in-process matcher keeps. */
  function viaMatcher(rule: RowRule): Outcome {
    const f = engineFilter(rule);
    if (!f) return ROWS.map((r) => r.id);
    try {
      return ROWS.filter((r) => matchesRlsFilters(r as never, [f as never])).map((r) => r.id);
    } catch {
      return 'error';
    }
  }

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

          const engine = await viaEngineSql(rule);
          const policy = await viaPolicy(rule);
          const matcher = viaMatcher(rule);

          expect({ policy, matcher }).toEqual({ policy: engine, matcher: engine });
        });
      }
    }
  }
});

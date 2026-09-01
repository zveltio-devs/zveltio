/**
 * What the four row-rule operators MEAN — in one place, for all four appliers.
 *
 * A rule stored in `zvd_rls_policies` is read by four pieces of code that each
 * emit their own form of it:
 *
 *   applyRlsFilters       a Kysely WHERE, on the live table
 *   buildRowRulePredicate SQL text, as a Postgres RESTRICTIVE policy
 *   matchesRlsFilters     JavaScript, in-process, for realtime fan-out
 *   rlsJsonConditions     SQL over the jsonb snapshots, for `?as_of=`
 *
 * ── Why this file exists, in numbers ──────────────────────────
 *
 * Each of those is about four lines long. The divergences between them did not
 * come from complexity; they came from the four lines being edited separately.
 *
 *   an independent audit, across three of them      :  7 divergences
 *   the fourth, once it was finally compared        : 18 of 56 cases
 *
 * One of the seven was a leak — `neq` against a NULL column: absent from
 * `/api/data`, delivered over SSE. Twelve of the eighteen were the SAME leak,
 * still alive on `?as_of=` a day after three appliers were corrected, because
 * nobody had counted the fourth. A comment asking that they be kept adjacent did
 * not prevent it, and adjacency was never the mechanism it was taken for.
 *
 * So the shared thing is not a shape or a base class — the four outputs are
 * genuinely different — it is the DECISIONS. Every semantic choice below is made
 * once and read four times. Changing what an operator means is one edit here;
 * it cannot be made in three places and forgotten in a fourth.
 *
 * ── The decisions, and why each is what it is ─────────────────
 *
 * **Comparison is textual.** A rule's value is ALWAYS a string: the four sources
 * are `user_id`, `user_email`, `user_role` and `static:VAL`. Against an integer
 * column the engine sends the string and Postgres casts it, so `code = '5'`
 * matches the row where code is 5. JavaScript's `5 === '5'` does not, and that
 * disagreement hid a row on one path and showed it on another until it was
 * measured. `String(a) === String(b)` is the spelling that agrees with the
 * database, and `->>` is its equivalent over jsonb.
 *
 * **A NULL field drops the row, on every operator including the negatives.**
 * This is the audit's finding, and the one that is counter-intuitive enough to
 * have been written wrong twice. `NULL <> 'x'` is NULL, not TRUE, and a WHERE
 * discards what it cannot confirm — so SQL drops such a row from `neq` and
 * `not_in`. In-memory code that reasons `undefined !== 'x'` therefore KEEPS a
 * row the database hides. Both negative operators say so explicitly here so no
 * applier has to re-derive it.
 */

/** The operators a stored rule may use. Anything else fails closed, loudly. */
export type RuleOperator = 'eq' | 'neq' | 'in' | 'not_in';

export interface OperatorSemantics {
  /** True when the operator takes a list rather than a scalar. */
  readonly list: boolean;
  /** Spelling in generated SQL text — the policy predicate and the jsonb path. */
  readonly sql: string;
  /** Spelling Kysely's `.where()` expects, which is its own dialect. */
  readonly kysely: string;
  /**
   * Whether a row survives, evaluated in memory.
   *
   * `value` is already known to be neither null nor undefined: the NULL rule is
   * applied by the caller, once, because it is the same for all four and it is
   * the one every hand-written version got wrong.
   */
  readonly keep: (value: unknown, condition: unknown) => boolean;
}

/** Text comparison — the one that agrees with Postgres. See the header. */
const same = (a: unknown, b: unknown): boolean => String(a) === String(b);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

export const RULE_OPERATORS: Readonly<Record<RuleOperator, OperatorSemantics>> = Object.freeze({
  eq: { list: false, sql: '=', kysely: '=', keep: (v, c) => same(v, c) },
  neq: { list: false, sql: '<>', kysely: '!=', keep: (v, c) => !same(v, c) },
  in: { list: true, sql: 'IN', kysely: 'in', keep: (v, c) => asList(c).some((x) => same(v, x)) },
  not_in: {
    list: true,
    sql: 'NOT IN',
    kysely: 'not in',
    keep: (v, c) => !asList(c).some((x) => same(v, x)),
  },
});

/**
 * A missing value drops the row, whatever the operator.
 *
 * Read by the in-memory applier. The three SQL appliers get it for free from
 * SQL's own NULL semantics, which is exactly why the in-memory one was the one
 * that disagreed: it had to be written by hand, and `undefined !== 'x'` looks
 * obviously true.
 */
export function droppedForMissingValue(value: unknown): boolean {
  return value === null || value === undefined;
}

/** The refusal every applier gives for an operator it cannot express. */
export function unsupportedOperator(field: string, op: string): Error {
  // Fail CLOSED, and identically in all four. `in` and `not_in` were once
  // accepted by the policy route and silently dropped by one applier, so a
  // policy an administrator saved, saw listed as enabled, and believed was
  // hiding rows did nothing at all. A security filter that cannot be applied
  // must not let the rows through — an operator can act on an error, not on a
  // leak they cannot see.
  return new Error(
    `RLS policy on "${field}" uses operator "${op}", which this engine ` +
      `cannot apply. Refusing the query rather than returning rows the policy was ` +
      `meant to hide. Fix or disable the policy.`,
  );
}

/** Whether a stored string is one of the four. */
export function isRuleOperator(op: string): op is RuleOperator {
  return Object.hasOwn(RULE_OPERATORS, op);
}

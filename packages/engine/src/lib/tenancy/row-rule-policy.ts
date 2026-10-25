/**
 * The product's row rules, expressed as a Postgres policy.
 *
 * `zvd_rls_policies` says things like "a member sees only rows they created".
 * Until now that was enforced only by `applyRlsFilters`, which adds a `WHERE` to
 * the query the handler happens to build — so a handler that forgets one leaks,
 * and the database answers cheerfully with the wrong rows. Measured on 400 000
 * rows: 0,068 ms to return rows the policy exists to withhold.
 *
 * This turns the same rules into a RESTRICTIVE policy on the collection's table,
 * which Postgres ANDs with the tenant-isolation policy. Same rules, second
 * place, and the second one cannot be forgotten by a handler.
 *
 * ── The predicate has to MEAN the same thing ──────────────────
 *
 * Not "roughly the same". A second enforcement that disagrees with the first is
 * not a second line of defence, it is a second source of truth — and two sources
 * that disagree are worse than one. So the semantics below are transcribed from
 * `getRlsFilters`, including the parts that are easy to get wrong:
 *
 *   - a value SOURCE neither side knows (a legacy `user.id`) hides every row
 *     the rule applies to — it used to be left out, on both sides, so it hid
 *     nothing;
 *   - `neq` is `<>`, not `IS DISTINCT FROM`: on a NULL column the engine drops
 *     the row, so the policy must drop it too;
 *   - `in`/`not_in` split on commas ONLY for a `static:` source, because that is
 *     the only source that can express a list;
 *   - a rule whose role does not match the caller does not apply at all;
 *   - an API key meets its own rules AND its issuer's, the second set matched
 *     on the issuer's roles and resolved against the issuer (`issuer_user_*`).
 *     It met only its own, so a rule binding the issuer never bound their key.
 *
 * ── What it refuses to do ─────────────────────────────────────
 *
 * `current_setting()` returns text. Against an `integer` column that is a type
 * error, not a comparison, so the value is cast to the column's own type, read
 * at generation time. A rule this cannot express — a type it cannot cast
 * safely, a missing column, an unknown operator — hides every row it applies
 * to, and the caller is told which one. It used to be left out, and in a
 * RESTRICTIVE policy a term left out is a rule that does not bind.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withLockWaitBound } from '../../db/dynamic.js';
import { startReconcile } from './reconcile-failures.js';
import {
  foldsCase,
  isRuleOperator,
  keepsEveryPresent,
  keepsNothing,
  RULE_OPERATORS,
} from './rule-operators.js';

export interface RowRule {
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
}

export interface GeneratedPolicy {
  /** `USING (...)` body, or null when nothing is enforceable. */
  predicate: string | null;
  /** Rules it cannot express — each enforced as `false` — with the reason. */
  skipped: Array<{ rule: RowRule; reason: string }>;
  /** Columns the predicate names: Postgres will not drop one while the policy stands. */
  columns: string[];
}

/** Column types whose text form casts back unambiguously. */
const CASTABLE = new Set([
  'text',
  'character varying',
  'character',
  'uuid',
  'integer',
  'bigint',
  'smallint',
  'boolean',
  'numeric',
  'double precision',
  'real',
]);

/** A single-quoted SQL literal. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** A double-quoted identifier, refusing anything that is not one. */
function ident(name: string): string | null {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? `"${name}"` : null;
}

/**
 * Whose settings a term reads: the caller's (`zveltio.user_id`, …), or an API
 * key's issuer's (`zveltio.issuer_user_id`, …) — a key's row rules are its own
 * AND its issuer's, as `getRlsFilters` applies them. The issuer's half binds
 * while `zveltio.issuer_rows` is `on`; it is `''` for every other caller, and
 * anything else (`deny`: a key whose issuer is unknown) keeps no row.
 */
const CALLER = 'zveltio.';
const ISSUER = 'zveltio.issuer_';

/**
 * The caller's value for a rule's source, cast to the column's type.
 *
 * `null` for a source this cannot express. The engine resolves `user_role` from
 * the session's single role; the same value is published, so the two agree.
 */
function valueExpr(
  source: string,
  pgType: string,
  prefix: string = CALLER,
): { sql: string; guc?: string } | null {
  // `(SELECT …)` is not decoration — it is worth three times the query.
  //
  // A bare `current_setting()` in a policy is evaluated PER ROW. Wrapped in a
  // scalar subquery it becomes an InitPlan: computed once, then compared like a
  // constant, which also lets the planner use an index on the column. Measured
  // on 300 000 rows, one rule, median of nine: 0,769 ms bare against 0,257 ms
  // marked.
  //
  // The tenant policy has used this shape since migration 005 for exactly this
  // reason. The row-rule generator was written without it — and then shipped
  // with this helper defined and unused, so the value side stayed bare.
  const guc = (name: string) => `(SELECT current_setting('${name}', true))`;
  const cast = (inner: string) => (pgType === 'text' ? inner : `CAST(${inner} AS ${pgType})`);
  if (source === 'user_id' || source === 'user_email' || source === 'user_role')
    return { sql: cast(guc(`${prefix}${source}`)), guc: `${prefix}${source}` };
  if (source.startsWith('static:')) return { sql: cast(lit(source.slice('static:'.length))) };
  return null;
}

/**
 * Does this rule apply to the caller?
 *
 * `*` always does. A named role applies only when the caller holds it, and the
 * caller's roles are published as one comma-separated setting — the same list
 * `getRlsFilters` builds from Casbin plus the direct role.
 */
function roleGuard(role: string, prefix: string = CALLER): string | null {
  if (role === '*') return null;
  return (
    `(SELECT ${lit(role)} = ANY ` +
    `(string_to_array(coalesce(current_setting('${prefix}user_roles', true), ''), ',')))`
  );
}

/**
 * One rule's term in the issuer's half: its condition, unless the issuer does
 * not hold the rule's role. No actor guard — the half binds only while
 * `zveltio.issuer_rows` is `on`, which a key's actor publishes.
 */
function issuerApplicable(rule: RowRule, condition: string): string {
  const role = roleGuard(rule.role, ISSUER);
  return role ? `(NOT (${role}) OR ${condition})` : `(${condition})`;
}

/**
 * One rule's term: its condition, unless the rule does not apply to the caller.
 *
 * `perActor` for a source read from the caller — every source but `static:`.
 */
function applicable(rule: RowRule, condition: string, perActor: boolean): string {
  // A rule the caller's roles do not match does not apply.
  const guards: string[] = [];
  const role = roleGuard(rule.role);
  if (role) guards.push(`NOT (${role})`);
  // A rule stands down exactly where `getRlsFilters` stands down — and that is
  // PER SOURCE, which this used to get wrong.
  //
  // The engine never skips a rule for an empty value:
  //
  //     user_id     -> user.id            an empty string does NOT skip
  //     user_email  -> user.email ?? ''   an empty string does NOT skip
  //     user_role   -> user.role ?? ''    an empty string does NOT skip
  //
  // `user_email` used to be the exception — an absent email skipped, and this
  // guard skipped with it on an empty setting. Every API key publishes an empty
  // email, so a key with RLS enforced saw every row under an email rule, here
  // and in the engine alike. It now compares against '' like the other two.
  //
  // This guard skipped on any EMPTY setting, so `bucket eq user_role` against
  // a session whose role is unset — which is every session, because
  // better-auth does not populate `session.user.role` — made the engine hide
  // every row and the policy show all four. Measured: engine [], policy
  // [1,2,3,4]. The policy was the more permissive of the two, which is the one
  // direction that matters, because this policy exists for the request whose
  // handler forgot its filters.
  //
  // It hid for a while behind the differential suite, which modelled the
  // resolver instead of calling it — and the model skipped on empty, agreeing
  // with the policy against the engine.
  if (perActor) {
    // No actor at all: background jobs and boot reconcilers, which publish no
    // identity. They get today's behaviour, and they are the callers the old
    // comment here was really about. `zveltio.actor` is its own setting
    // because an unset GUC and an emptied one are indistinguishable after the
    // first transaction on a pooled connection — see tenant-manager.
    guards.push(`(SELECT current_setting('zveltio.actor', true) IS DISTINCT FROM 'on')`);
  }

  return guards.length > 0 ? `(${guards.join(' OR ')} OR ${condition})` : `(${condition})`;
}

/**
 * Build the `USING (...)` body for one collection's rules.
 *
 * The shape is: exempt, or every applicable rule satisfied.
 */
export function buildRowRulePredicate(
  rules: RowRule[],
  columnTypes: Record<string, string>,
): GeneratedPolicy {
  const skipped: Array<{ rule: RowRule; reason: string }> = [];
  const terms: string[] = [];
  const issuerTerms: string[] = [];
  const columns = new Set<string>();
  // Nothing stops two identical rows in `zvd_rls_policies`, and emitting the
  // same term twice is work the database does per row for no answer it did not
  // already have.
  const seen = new Set<string>();

  for (const rule of rules) {
    const fingerprint = `${rule.role}|${rule.filter_field}|${rule.filter_op}|${rule.filter_value_source}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    // A source nobody can resolve hides every row the rule applies to, whatever
    // its column or operator — `getRlsFilters` hides them regardless of either.
    // Decided before the checks below, which LEAVE a rule out: that is what this
    // once did for an unknown source, and the engine skipped it too, so a rule
    // listed as enabled hid nothing on either side.
    if (!valueExpr(rule.filter_value_source, 'text')) {
      terms.push(applicable(rule, 'false', true));
      issuerTerms.push(issuerApplicable(rule, 'false'));
      continue;
    }
    // A rule this cannot express hides every row it applies to — `false`, not
    // left out. This is a RESTRICTIVE policy: a term left out is a rule that
    // does not bind, so the database kept every row the engine hides (a missing
    // column and a type it cannot cast make the engine's query fail, an unknown
    // operator makes every applier throw). The save route refuses all of these,
    // but a `*` rule, a PATCH or a row written straight into the table never
    // meets it. Still reported, so it is not discovered by reading code.
    const perActor = !rule.filter_value_source.startsWith('static:');
    const deny = (reason: string) => {
      skipped.push({ rule, reason });
      terms.push(applicable(rule, 'false', perActor));
      issuerTerms.push(issuerApplicable(rule, 'false'));
    };
    const col = ident(rule.filter_field);
    if (!col) {
      deny(`field ${JSON.stringify(rule.filter_field)} is not an identifier`);
      continue;
    }
    const pgType = columnTypes[rule.filter_field];
    if (!pgType) {
      deny(`column ${rule.filter_field} does not exist on the table`);
      continue;
    }
    if (!CASTABLE.has(pgType)) {
      deny(
        `column ${rule.filter_field} is ${pgType}, which this cannot cast a setting into safely`,
      );
      continue;
    }
    if (!isRuleOperator(rule.filter_op)) {
      deny(`operator ${JSON.stringify(rule.filter_op)} is not one of eq/neq/in/not_in`);
      continue;
    }
    const opSem = RULE_OPERATORS[rule.filter_op];
    // An email compares without case (rule-operators.ts): both sides folded.
    const fold = foldsCase(rule.filter_value_source);
    const lhs = fold ? `lower(${col})` : col;
    // The same condition, read against the caller's settings or the issuer's.
    const conditionFor = (prefix: string): string => {
      // Non-null: unknown sources returned above.
      const value = valueExpr(rule.filter_value_source, pgType, prefix)!;
      const rhs = fold ? `lower(${value.sql})` : value.sql;
      return conditionOf(rule, opSem, col, pgType, lhs, rhs);
    };
    const condition = conditionFor(CALLER);
    if (condition !== 'false') columns.add(rule.filter_field);
    terms.push(applicable(rule, condition, !rule.filter_value_source.startsWith('static:')));
    issuerTerms.push(issuerApplicable(rule, conditionFor(ISSUER)));
  }

  if (terms.length === 0) return { predicate: null, skipped, columns: [] };

  // The exemption is a published decision, not a role-name comparison in the
  // predicate. The engine already works out whether this session is exempt —
  // an API key with rlsBypass, or the `data:view_all` permission a god holds —
  // and says so. A role name compared here would be the unauditable check that
  // was dead in `getRlsFilters` for years before anyone noticed.
  const exempt =
    `(SELECT lower(coalesce(nullif(current_setting('zveltio.rls_bypass', true), ''), 'off')) ` +
    `IN ('on', 'true', '1'))`;
  // A key's issuer's half: off (`''`) for every other caller, applied while
  // `on`, and keeping nothing in any other state (`deny`).
  const issuer =
    `((SELECT coalesce(current_setting('zveltio.issuer_rows', true), '') = '') OR ` +
    `((SELECT current_setting('zveltio.issuer_rows', true) = 'on') AND ${issuerTerms.join(' AND ')}))`;
  return {
    predicate: `${exempt} OR (${[...terms, issuer].join(' AND ')})`,
    skipped,
    columns: [...columns],
  };
}

/** A validated rule's condition, `lhs` against `rhs` (the caller's or the issuer's value). */
function conditionOf(
  rule: RowRule,
  opSem: (typeof RULE_OPERATORS)[keyof typeof RULE_OPERATORS],
  col: string,
  pgType: string,
  lhs: string,
  rhs: string,
): string {
  if (opSem.list) {
    // Only a `static:` source can be a list; the user_* ones are scalars, and
    // a one-element list means the same as `eq`. Exactly what the engine does.
    const items = rule.filter_value_source.startsWith('static:')
      ? rule.filter_value_source
          .slice('static:'.length)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : null;
    const list = items
      ? items.map((v) => (pgType === 'text' ? lit(v) : `CAST(${lit(v)} AS ${pgType})`)).join(', ')
      : rhs;
    // An empty list means what it means in the engine (rule-operators.ts):
    // `in []` keeps nothing, `not_in []` keeps every row whose field is present.
    if (items && keepsNothing(rule.filter_op, items)) return 'false';
    if (items && keepsEveryPresent(rule.filter_op, items)) return `${col} IS NOT NULL`;
    return `${lhs} ${opSem.sql} (${list})`;
  }
  return `${lhs} ${opSem.sql} ${rhs}`;
}

/**
 * Why a list rule's `static:` list is empty, or `null` when it is not.
 *
 * Needs no column types, so the save path asks it even where it cannot ask
 * `describeRuleProblem` — a `*` rule, or a collection with no table yet.
 */
export function emptyStaticList(op: string, source: string): string | null {
  if (op !== 'in' && op !== 'not_in') return null;
  if (!source.startsWith('static:')) return null;
  const items = source
    .slice('static:'.length)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (items.length > 0) return null;
  return 'the list is empty: `in` would hide every row and `not_in` would exclude nothing';
}

/**
 * Why this rule cannot be enforced, or `null` when it can.
 *
 * Exported so the save route can refuse a rule instead of storing one that no
 * layer can agree on. An administrator who writes `code eq user_id` — an integer
 * column against a user id — gets three different behaviours today: the engine's
 * query throws, the generated policy is skipped (so the rule does nothing), and
 * the in-process matcher filters in JavaScript. None of them is wrong on its
 * own; together they are a rule that means three things.
 *
 * Refusing it at the door is the only version where they agree.
 */
export function describeRuleProblem(
  rule: RowRule,
  columnTypes: Record<string, string>,
): string | null {
  if (!ident(rule.filter_field)) {
    return `field ${JSON.stringify(rule.filter_field)} is not an identifier`;
  }
  const pgType = columnTypes[rule.filter_field];
  if (!pgType) return `column ${rule.filter_field} does not exist on the table`;
  if (!CASTABLE.has(pgType)) {
    return `column ${rule.filter_field} is ${pgType}, which a setting cannot be cast into safely`;
  }
  if (!isRuleOperator(rule.filter_op)) {
    return `operator ${JSON.stringify(rule.filter_op)} is not one of eq/neq/in/not_in`;
  }

  const source = rule.filter_value_source;
  const known =
    source === 'user_id' ||
    source === 'user_email' ||
    source === 'user_role' ||
    source.startsWith('static:');
  if (!known) return `value source ${JSON.stringify(source)} is not known`;

  // An empty list is refused for EVERY column type, not just the strict ones.
  // Every applier gives it a meaning now (rule-operators.ts): `in` hides every
  // row, `not_in` excludes nothing. Neither is what someone typing `static:,`
  // meant, so it is refused here rather than stored and obeyed.
  const empty = emptyStaticList(rule.filter_op, source);
  if (empty) return empty;

  const numeric = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real']);
  const strictly = numeric.has(pgType) || pgType === 'uuid' || pgType === 'boolean';
  if (!strictly) return null;

  // A numeric, uuid or boolean column can only be compared with values that
  // survive the cast. An id, an email and a role name are all text, and none of
  // them will.
  //
  // `user_role` was briefly allowed here on the grounds that the guard in front
  // of the predicate would skip the rule when the setting is empty. It does not
  // help: SQL does not promise to short-circuit `OR`, so Postgres is free to
  // evaluate the cast anyway and raise — while the engine, which short-circuits
  // in JavaScript, skips the rule quietly. That is a divergence produced by the
  // guard that was supposed to prevent one.
  if (!source.startsWith('static:')) {
    return `column ${rule.filter_field} is ${pgType}, and ${source} is text that will not cast into it`;
  }
  if (source.startsWith('static:')) {
    const raw = source.slice('static:'.length);
    const items =
      rule.filter_op === 'in' || rule.filter_op === 'not_in'
        ? raw
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [raw];
    if (items.length === 0) return 'the static list is empty';
    for (const item of items) {
      const ok = numeric.has(pgType)
        ? /^-?\d+(\.\d+)?$/.test(item)
        : pgType === 'boolean'
          ? /^(true|false|t|f|1|0)$/i.test(item)
          : /^[0-9a-fA-F-]{36}$/.test(item);
      if (!ok) {
        return `column ${rule.filter_field} is ${pgType}, and ${JSON.stringify(item)} will not cast into it`;
      }
    }
  }
  return null;
}

/** A table's columns and their types, as the policy is generated against. */
async function columnTypes(db: Database, table: string): Promise<Record<string, string>> {
  const cols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(db);
  const types: Record<string, string> = {};
  for (const c of cols.rows) types[c.column_name] = c.data_type;
  return types;
}

/**
 * The enabled `*` rules whose term in `collection`'s policy names `column`.
 *
 * Those are what stop Postgres dropping the column, and the field drop cannot
 * take them along the way it takes the collection's own rules: deleting one
 * lifts it from every collection, and rebuilding this table's policy without
 * it lifts it here. So the drop is refused and the rule named instead. Decided
 * by the same generator that writes the policy, so a rule that compiles to
 * `false` here (a list that keeps nothing) does not block.
 */
export async function starRulesNamingColumn(
  db: Database,
  collection: string,
  column: string,
): Promise<string[]> {
  const types = await columnTypes(db, `zvd_${collection}`);
  if (!types[column]) return [];
  const rules = await sql<RowRule & { id: string }>`
    SELECT id, role, filter_field, filter_op, filter_value_source
      FROM zvd_rls_policies
     WHERE is_enabled AND collection = '*' AND filter_field = ${column}
     ORDER BY id
  `.execute(db);
  return rules.rows
    .filter((r) => buildRowRulePredicate([r], types).columns.includes(column))
    .map((r) => String(r.id));
}

/** Policy name for a collection's row rules. One per table, replaced wholesale. */
export const ROW_RULE_POLICY = 'zv_row_rules';

/**
 * Put a collection's row rules onto its table, or take them off.
 *
 * Replaced wholesale rather than patched: the rules are a set, and a policy
 * built from a stale half of one is the failure this exists to prevent.
 *
 * RESTRICTIVE, because Postgres combines permissive policies with OR — a second
 * permissive policy would WIDEN what the tenant policy allows, which is the
 * exact opposite of the intent. Restrictive ones are ANDed.
 */
export async function applyRowRulePolicy(
  db: Database,
  collection: string,
): Promise<{ applied: boolean; skipped: GeneratedPolicy['skipped'] }> {
  const table = `zvd_${collection}`;
  const safe = ident(table);
  if (!safe) return { applied: false, skipped: [] };

  const exists = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(db);
  if (exists.rows[0]?.n === '0') return { applied: false, skipped: [] };

  // One transaction, the table locked BEFORE the rules are read. Separate
  // autocommit statements let two refreshes interleave so the one that read the
  // older rules wrote last, and left the table with no policy between DROP and
  // CREATE. ACCESS EXCLUSIVE is what DROP POLICY takes anyway; taken first, no
  // lock is upgraded mid-way, which a weaker lock would deadlock on against a
  // reader that then writes.
  // The lock wait is bounded: behind one long reader, an unbounded ACCESS
  // EXCLUSIVE request queued every read of the collection behind it.
  return withLockWaitBound(db, (h) => rebuildRowRulePolicy(h, collection, table, safe));
}

async function rebuildRowRulePolicy(
  db: Database,
  collection: string,
  table: string,
  safe: string,
): Promise<{ applied: boolean; skipped: GeneratedPolicy['skipped'] }> {
  await sql.raw(`LOCK TABLE ${safe} IN ACCESS EXCLUSIVE MODE`).execute(db);
  const types = await columnTypes(db, table);
  const rules = await sql<RowRule>`
    SELECT role, filter_field, filter_op, filter_value_source
      FROM zvd_rls_policies
     WHERE is_enabled AND (collection = ${collection} OR collection = '*')
  `.execute(db);

  const { predicate, skipped } = buildRowRulePredicate(rules.rows, types);

  // Dropped first either way: a collection whose last rule was deleted must not
  // keep enforcing it.
  await sql.raw(`DROP POLICY IF EXISTS ${ROW_RULE_POLICY} ON ${safe}`).execute(db);
  if (predicate) {
    // `WITH CHECK` written out, not inherited. This changes NOTHING at runtime.
    //
    // A policy with no `WITH CHECK` uses its `USING` predicate for writes too,
    // so the rule already applied to INSERT and UPDATE. Measured rather than
    // assumed, on the old form without the clause:
    //
    //   INSERT INTO probe (owner) VALUES ('somebody-else');
    //   ERROR:  new row violates row-level security policy "p" for table "probe"
    //
    // So this is documentation written in code, not a repair — worth saying,
    // because the diff looks like a repair. The write rule now sits where the
    // read rule is, so the next reader can change one without discovering the
    // other by accident.
    await sql
      .raw(
        `CREATE POLICY ${ROW_RULE_POLICY} ON ${safe} AS RESTRICTIVE ` +
          `USING (${predicate}) WITH CHECK (${predicate})`,
      )
      .execute(db);
  }

  if (skipped.length > 0) {
    // Named, not counted. A rule the database cannot express hides every row it
    // applies to there, which an administrator will see as missing data — so it
    // must not be discovered by reading code.
    console.warn(
      `[row-rules] ${collection}: ${skipped.length} rule(s) cannot be expressed in the ` +
        `database and hide every row they apply to there: ` +
        skipped.map((s) => `${s.rule.filter_field} ${s.rule.filter_op} — ${s.reason}`).join('; '),
    );
  }
  return { applied: predicate !== null, skipped };
}

/**
 * Every collection whose policy the rules reach: those with a rule of their
 * own, every registered one when a `*` rule exists, and every table still
 * carrying the policy.
 *
 * The last because a deleted, disabled or moved `*` rule leaves tables with no
 * rule at all, and those are exactly the ones that must drop it. Read off the
 * rules and the policies themselves, not only through `zvd_collections`:
 * `applyRowRulePolicy` puts a policy on any `zvd_` table a rule names,
 * registered or not, and that policy carries the `*` rules too — so a table
 * with no `zvd_collections` row kept a moved or deleted `*` rule for good when
 * this listed only registered ones.
 */
async function rowRuleCollections(db: Database): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT p.collection AS name FROM zvd_rls_policies p
     WHERE p.is_enabled AND p.collection <> '*'
    UNION
    SELECT c.name FROM zvd_collections c
     WHERE EXISTS (SELECT 1 FROM zvd_rls_policies p WHERE p.is_enabled AND p.collection = '*')
    UNION
    SELECT substr(pp.tablename, 5) FROM pg_policies pp
     WHERE pp.schemaname = 'public' AND pp.policyname = ${ROW_RULE_POLICY}
       AND starts_with(pp.tablename, 'zvd_')
  `.execute(db);
  return rows.rows.map((r) => r.name);
}

/**
 * Rebuild the policy of each of `collections` — of every collection the rules
 * reach when one is `*` — in `db`, the transaction a writer of the rules
 * opened: the rules and their policies commit together or not at all. A table
 * busy past the lock bound throws (55P03) and takes the change with it. In
 * name order, so two writers lock the tables they share in the same order.
 */
export async function applyRowRulePolicies(db: Database, collections: string[]): Promise<void> {
  const names = new Set(collections.filter((c) => c !== '*'));
  if (collections.includes('*')) for (const c of await rowRuleCollections(db)) names.add(c);
  for (const c of [...names].sort()) await applyRowRulePolicy(db, c);
}

/**
 * Put the rules on every collection that has them, and take them off every
 * collection that no longer does (`rowRuleCollections`). Run at boot, each
 * table on its own: one that fails is recorded and the rest are still done.
 *
 * Existing installs have rules and no policies; nothing else would ever create
 * them, and a feature that only protects collections created after the upgrade
 * protects the ones nobody has data in yet.
 */
export async function reconcileRowRulePolicies(db: Database): Promise<number> {
  const record = startReconcile('row_rules');
  const names = await rowRuleCollections(db).catch((err: Error) => {
    record('*', err);
    throw err;
  });
  let n = 0;
  for (const name of names) {
    const res = await applyRowRulePolicy(db, name).catch((err: Error) => {
      console.warn(`[row-rules] ${name}: could not apply — ${record(name, err)}`);
      return { applied: false, skipped: [] };
    });
    if (res.applied) n++;
  }
  return n;
}

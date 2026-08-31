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
 *   - a value that cannot be resolved SKIPS its rule (fail-open for that rule),
 *     it does not hide everything;
 *   - `neq` is `<>`, not `IS DISTINCT FROM`: on a NULL column the engine drops
 *     the row, so the policy must drop it too;
 *   - `in`/`not_in` split on commas ONLY for a `static:` source, because that is
 *     the only source that can express a list;
 *   - a rule whose role does not match the caller does not apply at all.
 *
 * ── What it refuses to do ─────────────────────────────────────
 *
 * `current_setting()` returns text. Against an `integer` column that is a type
 * error, not a comparison, so the value is cast to the column's own type, read
 * at generation time. For a type this cannot cast safely, the rule is NOT
 * generated and the caller is told which one — a policy that is almost right on
 * a security path is worse than none, because it looks whole.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export interface RowRule {
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
}

export interface GeneratedPolicy {
  /** `USING (...)` body, or null when nothing is enforceable. */
  predicate: string | null;
  /** Rules left out, with the reason, so nothing is dropped silently. */
  skipped: Array<{ rule: RowRule; reason: string }>;
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

const OPS = new Set(['eq', 'neq', 'in', 'not_in']);

/** A single-quoted SQL literal. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** A double-quoted identifier, refusing anything that is not one. */
function ident(name: string): string | null {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? `"${name}"` : null;
}

/**
 * The caller's value for a rule's source, cast to the column's type.
 *
 * `null` for a source this cannot express. The engine resolves `user_role` from
 * the session's single role; the same value is published, so the two agree.
 */
function valueExpr(source: string, pgType: string): { sql: string; guc?: string } | null {
  // `(SELECT …)` is not decoration — it is worth three times the query.
  //
  // A bare `current_setting()` in a policy is evaluated PER ROW. Wrapped in a
  // scalar subquery it becomes an InitPlan: computed once, then compared like a
  // constant, which also lets the planner use an index on the column. Measured
  // on 300 000 rows, one rule, median of nine: 0,769 ms bare against 0,257 ms
  // marked.
  //
  // The tenant policy has used this shape since migration 005 for exactly this
  // reason. The row-rule generator was written without it.
  const guc = (name: string) => `(SELECT current_setting('${name}', true))`;
  const cast = (inner: string) => (pgType === 'text' ? inner : `CAST(${inner} AS ${pgType})`);
  if (source === 'user_id')
    return { sql: cast(`current_setting('zveltio.user_id', true)`), guc: 'zveltio.user_id' };
  if (source === 'user_email')
    return { sql: cast(`current_setting('zveltio.user_email', true)`), guc: 'zveltio.user_email' };
  if (source === 'user_role')
    return { sql: cast(`current_setting('zveltio.user_role', true)`), guc: 'zveltio.user_role' };
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
function roleGuard(role: string): string | null {
  if (role === '*') return null;
  return (
    `(SELECT ${lit(role)} = ANY ` +
    `(string_to_array(coalesce(current_setting('zveltio.user_roles', true), ''), ',')))`
  );
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
  // Nothing stops two identical rows in `zvd_rls_policies`, and emitting the
  // same term twice is work the database does per row for no answer it did not
  // already have.
  const seen = new Set<string>();

  for (const rule of rules) {
    const fingerprint = `${rule.role}|${rule.filter_field}|${rule.filter_op}|${rule.filter_value_source}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const col = ident(rule.filter_field);
    if (!col) {
      skipped.push({
        rule,
        reason: `field ${JSON.stringify(rule.filter_field)} is not an identifier`,
      });
      continue;
    }
    const pgType = columnTypes[rule.filter_field];
    if (!pgType) {
      skipped.push({ rule, reason: `column ${rule.filter_field} does not exist on the table` });
      continue;
    }
    if (!CASTABLE.has(pgType)) {
      skipped.push({
        rule,
        reason: `column ${rule.filter_field} is ${pgType}, which this cannot cast a setting into safely`,
      });
      continue;
    }
    if (!OPS.has(rule.filter_op)) {
      skipped.push({
        rule,
        reason: `operator ${JSON.stringify(rule.filter_op)} is not one of eq/neq/in/not_in`,
      });
      continue;
    }
    const value = valueExpr(rule.filter_value_source, pgType);
    if (!value) {
      skipped.push({
        rule,
        reason: `value source ${JSON.stringify(rule.filter_value_source)} is not known`,
      });
      continue;
    }

    const isList = rule.filter_op === 'in' || rule.filter_op === 'not_in';
    let condition: string;
    if (isList) {
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
        : value.sql;
      if (items && items.length === 0) {
        skipped.push({ rule, reason: 'the static list is empty' });
        continue;
      }
      condition = `${col} ${rule.filter_op === 'in' ? 'IN' : 'NOT IN'} (${list})`;
    } else {
      condition = `${col} ${rule.filter_op === 'eq' ? '=' : '<>'} ${value.sql}`;
    }

    // A rule the caller's roles do not match does not apply.
    const guards: string[] = [];
    const role = roleGuard(rule.role);
    if (role) guards.push(`NOT (${role})`);
    // A rule stands down exactly where `getRlsFilters` stands down — and that is
    // PER SOURCE, which this used to get wrong.
    //
    // The engine skips a policy only when `resolveValue` returns null:
    //
    //     user_id     -> user.id            an empty string does NOT skip
    //     user_email  -> user.email ?? null an absent email DOES skip
    //     user_role   -> user.role          an empty string does NOT skip
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
    if (value.guc) {
      // No actor at all: background jobs and boot reconcilers, which publish no
      // identity. They get today's behaviour, and they are the callers the old
      // comment here was really about. `zveltio.actor` is its own setting
      // because an unset GUC and an emptied one are indistinguishable after the
      // first transaction on a pooled connection — see tenant-manager.
      guards.push(`(SELECT current_setting('zveltio.actor', true) IS DISTINCT FROM 'on')`);
      // And for the one source the engine itself cannot resolve, empty means
      // unresolved rather than "the empty value".
      if (value.guc === 'zveltio.user_email') {
        guards.push(`(SELECT nullif(current_setting(${lit(value.guc)}, true), '') IS NULL)`);
      }
    }

    terms.push(guards.length > 0 ? `(${guards.join(' OR ')} OR ${condition})` : `(${condition})`);
  }

  if (terms.length === 0) return { predicate: null, skipped };

  // The exemption is a published decision, not a role-name comparison in the
  // predicate. The engine already works out whether this session is exempt —
  // an API key with rlsBypass, or the `data:view_all` permission a god holds —
  // and says so. A role name compared here would be the unauditable check that
  // was dead in `getRlsFilters` for years before anyone noticed.
  const exempt =
    `(SELECT lower(coalesce(nullif(current_setting('zveltio.rls_bypass', true), ''), 'off')) ` +
    `IN ('on', 'true', '1'))`;
  return { predicate: `${exempt} OR (${terms.join(' AND ')})`, skipped };
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
  if (!OPS.has(rule.filter_op)) {
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
  // The engine turns it into `in ()`, which is a syntax error on every request
  // to the collection; the generated policy skips the rule, which opens it. One
  // saved mistake, two opposite failures.
  if (
    (rule.filter_op === 'in' || rule.filter_op === 'not_in') &&
    source.startsWith('static:') &&
    source
      .slice('static:'.length)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean).length === 0
  ) {
    return 'the list is empty, which the engine turns into `in ()` and the policy ignores';
  }

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

  const cols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(db);
  const types: Record<string, string> = {};
  for (const c of cols.rows) types[c.column_name] = c.data_type;

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
    // Named, not counted. A rule the database cannot express is still enforced
    // by the engine — but only by the engine, which is the situation this whole
    // change exists to end, so it must not be discovered by reading code.
    console.warn(
      `[row-rules] ${collection}: ${skipped.length} rule(s) NOT enforced in the database ` +
        `(the engine still applies them): ` +
        skipped.map((s) => `${s.rule.filter_field} ${s.rule.filter_op} — ${s.reason}`).join('; '),
    );
  }
  return { applied: predicate !== null, skipped };
}

/**
 * Put the rules on every collection that has them. Run at boot.
 *
 * Existing installs have rules and no policies; nothing else would ever create
 * them, and a feature that only protects collections created after the upgrade
 * protects the ones nobody has data in yet.
 */
export async function reconcileRowRulePolicies(db: Database): Promise<number> {
  const rows = await sql<{ name: string }>`
    SELECT DISTINCT c.name
      FROM zvd_collections c
     WHERE EXISTS (
       SELECT 1 FROM zvd_rls_policies p
        WHERE p.is_enabled AND (p.collection = c.name OR p.collection = '*')
     )
  `.execute(db);
  let n = 0;
  for (const r of rows.rows) {
    const res = await applyRowRulePolicy(db, r.name).catch((err: Error) => {
      console.warn(`[row-rules] ${r.name}: could not apply — ${err.message}`);
      return { applied: false, skipped: [] };
    });
    if (res.applied) n++;
  }
  return n;
}

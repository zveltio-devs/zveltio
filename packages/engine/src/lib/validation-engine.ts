/**
 * Validation Engine
 *
 * Loads validation rules from zv_validation_rules, caches them in-memory for 60s,
 * and provides helpers to validate field values and entire records.
 * Expression rules are CEL (https://cel.dev), evaluated by @bufbuild/cel — no
 * eval/Function usage, no loops beyond the bounded macros, no I/O.
 */

import { Script, createContext } from 'node:vm';
import { celEnv, isCelError, parse, plan } from '@bufbuild/cel';
import { RE2JS } from '@bufbuild/re2';
import { sql } from 'kysely';
import { withSavepoint } from './savepoint.js';
import { getCurrentTrxTenant } from './tenancy/index.js';
import type { Database } from '../db/index.js';

type CelExpr = ReturnType<typeof parse>['expr'];
type CelProgram = ReturnType<typeof plan>;

// `matches()` would otherwise run a JavaScript RegExp synchronously on the
// write path, where a backtracking pattern stalls the whole process. RE2 is
// linear-time, and it is also the dialect the CEL specification defines
// `matches` in, so a rule behaves here as it does in any other CEL runtime.
const env = celEnv({
  re2: {
    compile(pattern: string) {
      const re = new RE2JS(pattern);
      return { test: (text: string) => re.test(text) };
    },
  },
});

// Bounds on what may be stored. They keep a rule readable and its plan small;
// they do NOT bound what it costs to run — see EVALUATION_TIMEOUT_MS.
const MAX_EXPRESSION_LENGTH = 1024;
const MAX_EXPRESSION_DEPTH = 32;

// CEL has no unbounded loops, but its cost is not proportional to the value it
// checks. The macros (`all`, `exists`, `map`, …) nest, so
// `value.all(a, value.all(b, value.all(c, a+b+c >= 0)))` is N^3 — 19 s of a
// blocked event loop over a 300-element list — and `x in value` or
// `value == value` inside a single loop is N^2. No static cap closes that:
// every cap on the expression leaves the value's size as a free multiplier.
// So evaluation is preempted instead. `node:vm`'s `timeout` interrupts the
// running JavaScript wherever it is — inside @bufbuild/cel's interpreter too,
// which is plain functions of this realm — synchronously and in-process, with
// no worker to start or message. A rule that runs out the clock is refused,
// which on the write path refuses the write. 50 ms is orders of magnitude above
// what a validation rule needs (a microsecond or two per element).
// ponytail: memory is bounded only by what can be allocated within the deadline
// (measured: about 50 MB for the worst shapes found); a heap cap needs a Worker.
// An interrupted evaluation skips @bufbuild/cel's `finally` and leaves one
// stale entry on its internal context stack — one array slot per refusal.
const EVALUATION_TIMEOUT_MS = 50;
let evaluateNow: () => unknown = () => null;
const evaluationRealm = createContext({ run: () => evaluateNow() });
const runEvaluation = new Script('run()');

// expr-eval-fork, which this replaced, reached JavaScript objects directly, so
// rules were screened for prototype-pollution names. CEL selects only declared
// fields of a value (`value.constructor` is "field not found"), so this guard
// no longer stands between a rule and the process. It stays because a
// legitimate rule never needs these names and refusing them costs nothing.
const UNSAFE_EXPR_TOKEN =
  /(__proto__|constructor|prototype|__define[GS]etter__|__lookup[GS]etter__)/;

/**
 * Result of evaluating an expression rule.
 *
 * `refused` is a third state on purpose. The two callers want opposite things
 * from an expression they will not run: the write path evaluating a record
 * should not fail a save over a rule someone else wrote badly, while the rule
 * editor testing an expression must not report "passed" for something it never
 * evaluated. Collapsing refusal into a boolean forces one of them to be wrong.
 */
export type ExpressionRuleResult =
  | { status: 'passed' }
  | { status: 'failed' }
  | { status: 'refused'; reason: string };

/**
 * Names an expression refers to without binding them, functions it calls that
 * the environment does not define, and its nesting depth.
 *
 * Comprehension variables are scoped to the parts of the macro that see them —
 * `value.all(x, x > 0)` binds `x` in the predicate, not in the list it ranges
 * over — so a name is "unknown" exactly when evaluation would report it
 * unresolved.
 */
function inspect(
  e: CelExpr | undefined,
  bound: ReadonlySet<string>,
  depth: number,
  out: { unknown: Set<string>; unknownFuncs: Set<string>; depth: number },
): void {
  if (!e) return;
  out.depth = Math.max(out.depth, depth);
  const next = depth + 1;
  const k = e.exprKind;
  switch (k.case) {
    case 'identExpr':
      if (!bound.has(k.value.name)) out.unknown.add(k.value.name);
      return;
    case 'selectExpr':
      inspect(k.value.operand, bound, next, out);
      return;
    case 'callExpr':
      // Operators are spelled `_&&_`, `@in`, …; only a plain name can be a
      // function the environment does not define.
      if (/^[A-Za-z]\w*$/.test(k.value.function) && !env.funcs.find(k.value.function)) {
        out.unknownFuncs.add(k.value.function);
      }
      inspect(k.value.target, bound, next, out);
      for (const a of k.value.args) inspect(a, bound, next, out);
      return;
    case 'listExpr':
      for (const a of k.value.elements) inspect(a, bound, next, out);
      return;
    case 'structExpr':
      for (const entry of k.value.entries) {
        if (entry.keyKind.case === 'mapKey') inspect(entry.keyKind.value, bound, next, out);
        inspect(entry.value, bound, next, out);
      }
      return;
    case 'comprehensionExpr': {
      const c = k.value;
      inspect(c.iterRange, bound, next, out);
      inspect(c.accuInit, bound, next, out);
      const inner = new Set(bound);
      for (const name of [c.iterVar, c.iterVar2, c.accuVar]) if (name) inner.add(name);
      inspect(c.loopCondition, inner, next, out);
      inspect(c.loopStep, inner, next, out);
      inspect(c.result, inner, next, out);
      return;
    }
    default:
      return;
  }
}

const VALUE_ONLY: ReadonlySet<string> = new Set(['value']);
/** A flow `condition` step sees the run's trigger data and the previous step's output. */
const FLOW_CONDITION_SCOPE: ReadonlySet<string> = new Set(['trigger', 'output']);
/**
 * A `transition` rule sees the value being written and the one stored before
 * it: `previous` is `null` on create. `previous == 'draft' ? value in ['sent',
 * 'cancelled'] : value == previous` is the shape the rule type exists for.
 */
const TRANSITION_SCOPE: ReadonlySet<string> = new Set(['value', 'previous']);

/**
 * Decide whether an expression may be stored at all, and compile it if so.
 *
 * Parsing is the load-bearing check: CEL has no statements, no property access
 * beyond a value's own fields, and no calls to anything the environment did not
 * declare. The allowlist on top is not about safety — `process.exit(1)` would
 * only ever be refused as unresolved — but about a rule that can never evaluate
 * sitting in the database looking configured.
 */
function compile(
  expression: string,
  scope: ReadonlySet<string>,
): { ok: true; program: CelProgram } | { ok: false; reason: string } {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_EXPRESSION_LENGTH} characters` };
  }
  if (UNSAFE_EXPR_TOKEN.test(expression)) {
    return { ok: false, reason: 'contains a blocked token (prototype-pollution vector)' };
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(expression);
  } catch (err) {
    // Phrased to read after "The expression ..." in the extension's 400, which
    // is where a rule author sees it. Rules written before the switch to CEL
    // most often fail here on `and`/`or`/`not`, hence the pointer.
    return {
      ok: false,
      reason: `could not be parsed as CEL (use \`&&\`, \`||\`, \`!\`): ${(err as Error).message}`,
    };
  }
  const found = { unknown: new Set<string>(), unknownFuncs: new Set<string>(), depth: 0 };
  inspect(parsed.expr, scope, 1, found);
  if (found.depth > MAX_EXPRESSION_DEPTH) {
    return { ok: false, reason: `nests deeper than ${MAX_EXPRESSION_DEPTH} levels` };
  }
  if (found.unknown.size > 0) {
    return {
      ok: false,
      reason:
        `refers to ${[...found.unknown].map((v) => `\`${v}\``).join(', ')}, and the only ` +
        `${scope.size === 1 ? 'value' : 'values'} in scope ${scope.size === 1 ? 'is' : 'are'} ` +
        [...scope].map((v) => `\`${v}\``).join(', '),
    };
  }
  if (found.unknownFuncs.size > 0) {
    return {
      ok: false,
      reason: `calls ${[...found.unknownFuncs].map((f) => `\`${f}\``).join(', ')}, which CEL does not define`,
    };
  }
  try {
    return { ok: true, program: plan(env, parsed) };
  } catch (err) {
    // The planner throws on a few shapes the parser accepts (an invalid
    // selection, for one). That is a rule that can never run, not a crash.
    return { ok: false, reason: `could not be compiled: ${(err as Error).message}` };
  }
}

// Rules are re-read every 60s and evaluated on every write that touches their
// field, so compiling once per distinct expression matters.
// ponytail: cleared wholesale at the cap; an LRU only if rule churn ever makes that visible.
const programs = new Map<string, CelProgram>();
const MAX_CACHED_PROGRAMS = 1000;

export function checkValidationExpression(
  expression: string,
  /** `transition` rules also see `previous`; every other expression rule only `value`. */
  ruleType?: string,
): { ok: true } | { ok: false; reason: string } {
  const compiled = compile(expression, ruleType === 'transition' ? TRANSITION_SCOPE : VALUE_ONLY);
  return compiled.ok ? { ok: true } : compiled;
}

/** Save-time check for a flow `condition` step's expression. */
export function checkConditionExpression(
  expression: string,
): { ok: true } | { ok: false; reason: string } {
  const compiled = compile(expression, FLOW_CONDITION_SCOPE);
  return compiled.ok ? { ok: true } : compiled;
}

// Field types whose values CEL should see as `int`. Everything else numeric is
// `double`. CEL does not mix the two in arithmetic (`value * 2` on a double is
// a type error; write `value * 2.0`), so binding by the column's declared type
// keeps a rule's meaning from depending on whether one particular value
// happened to be whole.
const INTEGER_FIELD_TYPES = new Set(['integer', 'int', 'bigint', 'smallint']);
const DOUBLE_FIELD_TYPES = new Set(['number', 'float', 'real', 'decimal']);

/**
 * One value as CEL sees it, by the field's declared type. A `transition` rule
 * binds the written value (deserialized by the field pipeline) and the stored
 * one (as the driver returned it) through here, so both sides must land in the
 * same shape: a `numeric` column reads back as the string `"10.50"` while the
 * write carries the number, and `value >= previous` was refused as
 * `(double, string)` on every write. Dates compare as ISO text: `date` as
 * `YYYY-MM-DD`, `datetime` as UTC instants, so the order of the strings is the
 * order of the dates.
 */
function toCelValue(value: unknown, fieldType: string | undefined): unknown {
  if (value === undefined) return null;
  if (fieldType === 'date' || fieldType === 'datetime') {
    const instant =
      value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    if (instant && !Number.isNaN(instant.getTime())) {
      const iso = instant.toISOString();
      return fieldType === 'date' ? iso.slice(0, 10) : iso;
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (fieldType && INTEGER_FIELD_TYPES.has(fieldType)) {
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  }
  if (fieldType && DOUBLE_FIELD_TYPES.has(fieldType) && typeof value === 'string') {
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * Evaluate an expression rule against a single value.
 *
 * The one place this engine evaluates a user-authored expression. It is
 * exported, and handed to extensions through `ctx.internals`, because the
 * validation extension had grown its own copy built on
 * `new Function('value', 'return ' + expression)` — which reads as sandboxed
 * and is not: a Function body closes over the global scope, so a stored rule
 * could reach `process`, `Bun`, and the filesystem. Two implementations of one
 * rule type is how the safe one ends up unused.
 *
 * `fieldType` is the type of the field the rule sits on; it decides whether a
 * whole number is a CEL `int` or `double`. Without it numbers are `double`.
 */
export function evaluateExpressionRule(
  expression: string,
  value: unknown,
  fieldType?: string,
): ExpressionRuleResult {
  // The binding type is CEL's input union; `toCelValue` returns `unknown`
  // because a column can hold anything. An unsupported shape is reported by
  // the evaluator as an error, which lands in the refusal below.
  return evaluate(expression, VALUE_ONLY, {
    value: toCelValue(value, fieldType),
  } as Parameters<CelProgram>[0]);
}

/**
 * Evaluate a `transition` rule: the value being written against the one stored
 * before it (`null` on create). Both bound by the field's declared type.
 */
export function evaluateTransitionRule(
  expression: string,
  value: unknown,
  previous: unknown,
  fieldType?: string,
): ExpressionRuleResult {
  return evaluate(expression, TRANSITION_SCOPE, {
    value: toCelValue(value, fieldType),
    previous: toCelValue(previous, fieldType),
  } as Parameters<CelProgram>[0]);
}

/**
 * Evaluate a flow `condition` step. Same compiler, cache and deadline as an
 * expression rule; only the names in scope differ. Trigger data and step
 * output are JSON, so numbers are CEL `double` (`trigger.total > 10000` still
 * compares, CEL orders int and double together).
 */
export function evaluateCondition(
  expression: string,
  bindings: { trigger: unknown; output: unknown },
): ExpressionRuleResult {
  return evaluate(expression, FLOW_CONDITION_SCOPE, {
    trigger: toCelJson(bindings.trigger),
    output: toCelJson(bindings.output),
  } as Parameters<CelProgram>[0]);
}

/**
 * Trigger data and step output, as CEL sees JSON: a Date is its ISO string, an
 * undefined property is absent (`has()` is false), and a bigint (an int8
 * column in a trigger's record) a double like every other number, so
 * `trigger.record.n * 2.0` does not depend on the column's width.
 */
function toCelJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toCelJson);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toCelJson(v);
    return out;
  }
  return value;
}

function evaluate(
  expression: string,
  scope: ReadonlySet<string>,
  bindings: Parameters<CelProgram>[0],
): ExpressionRuleResult {
  // Keyed by scope too: the same text compiles against `value` and fails
  // against `trigger`, and the other way round.
  const key = `${[...scope].join(',')}\n${expression}`;
  let program = programs.get(key);
  if (!program) {
    const compiled = compile(expression, scope);
    if (!compiled.ok) return { status: 'refused', reason: compiled.reason };
    program = compiled.program;
    if (programs.size >= MAX_CACHED_PROGRAMS) programs.clear();
    programs.set(key, program);
  }
  const run = program;
  let result: unknown;
  try {
    evaluateNow = () => run(bindings);
    result = runEvaluation.runInContext(evaluationRealm, { timeout: EVALUATION_TIMEOUT_MS });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return {
        status: 'refused',
        reason: `took longer than ${EVALUATION_TIMEOUT_MS} ms to evaluate`,
      };
    }
    return { status: 'refused', reason: `could not be evaluated: ${(err as Error).message}` };
  } finally {
    // Do not keep the last record's value reachable between writes.
    evaluateNow = () => null;
  }
  if (isCelError(result)) {
    return { status: 'refused', reason: `could not be evaluated: ${result.message}` };
  }
  if (typeof result !== 'boolean') {
    return { status: 'refused', reason: 'does not evaluate to true or false' };
  }
  return result ? { status: 'passed' } : { status: 'failed' };
}

export interface ValidationRule {
  /**
   * Needed to decide group membership — `zvd_validation_rule_groups.rule_ids`
   * is an array of these.
   *
   * Optional because `validateFieldValue` is also called directly with
   * hand-built rules (the extension's rule tester, and a good many unit tests),
   * and those have no row behind them. A rule with no id belongs to no group,
   * which is the correct reading.
   */
  id?: string;
  /** Set on a tenant's own rule (migration 092): never a group member. */
  tenant_id?: string | null;
  field_name: string;
  rule_type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  rule_config: Record<string, any>;
  error_message: string | null;
}

/**
 * The database handle, set once at boot.
 *
 * Same shape as `initRls` / `initTenantManager` next door, and for the same
 * reason: the rules are per-collection and have to be read from somewhere, but
 * the place they are needed — `processInput`, on the field pipeline — takes a
 * record and a collection definition and no database. Threading one through
 * would mean an optional parameter, and an optional parameter on a validation
 * step is a thing four call sites can forget.
 */
let _db: Database | null = null;

export function initValidationEngine(db: Database): void {
  _db = db;
}

/** The handle, or null when the engine has not booted (unit tests, CLI). */
export function getValidationDb(): Database | null {
  return _db;
}

// In-memory rules cache (TTL 60s), keyed `<collection>:<field>@<tenant>`.
const rulesCache = new Map<string, { rules: ValidationRule[]; ts: number }>();

/**
 * The active rules for a write: the instance rules and those of the tenant the
 * open tenant transaction writes as (`getCurrentTrxTenant`), where every write
 * path runs — data API, bulk, sync, `dynamicInsert`, a worker's call, a job
 * inside `withTenantIsolation`. No tenant transaction: instance rules only.
 * Filtered here, not by RLS: the read runs on the pool, as the engine.
 */
export async function getValidationRules(
  db: Database,
  collection: string,
  fieldName?: string,
): Promise<ValidationRule[]> {
  const tenant = getCurrentTrxTenant();
  const cacheKey = `${collection}:${fieldName || '*'}@${tenant ?? ''}`;
  const cached = rulesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.rules;

  let query = db
    .selectFrom('zv_validation_rules')
    .select(['id', 'tenant_id', 'field_name', 'rule_type', 'rule_config', 'error_message'])
    .where('collection', '=', collection)
    .where('is_active', '=', true)
    .where((eb) =>
      tenant
        ? eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', tenant)])
        : eb('tenant_id', 'is', null),
    );

  if (fieldName) query = query.where('field_name', '=', fieldName);

  // rule_config is JSONB → typed as unknown; coerce to the runtime contract.
  const rules: ValidationRule[] = (await query.execute()).map((row) => ({
    id: String(row.id),
    tenant_id: row.tenant_id,
    field_name: row.field_name,
    rule_type: row.rule_type,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    rule_config: (row.rule_config ?? {}) as Record<string, any>,
    error_message: row.error_message,
  }));
  // ponytail: per-tenant keys never expire on their own; a crude bound until an LRU is needed.
  if (rulesCache.size > 10_000) rulesCache.clear();
  rulesCache.set(cacheKey, { rules, ts: Date.now() });
  return rules;
}

/**
 * A `uuid[]` column as a JS array.
 *
 * Bun's driver returns array columns as PostgreSQL's own text literal —
 * `"{6c675ffa-…,18215b10-…}"` — not as a JS array. Calling `.map` on that throws,
 * and the throw was caught by the guard below, so every group silently vanished
 * and the OR logic looked implemented while behaving exactly as before. Two hours
 * of "the fix does not work" before measuring what the driver actually returns.
 *
 * Same shape as the NUMERIC problem in `lib/numeric.ts`: the wire format is text,
 * the code assumed a native type, and nothing said otherwise.
 */
export function toIdArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '');
  if (inner === '') return [];
  return inner.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
}

/** A rule group as `developer/validation` stores it. */
interface RuleGroup {
  field_name: string;
  logic: string;
  rule_ids: string[];
}

const groupsCache = new Map<string, { groups: RuleGroup[]; ts: number }>();

/**
 * Rule groups for a collection — or none, when the feature is not installed.
 *
 * An administrator could create a group with `logic: "OR"`, see it listed as
 * active, and have it change nothing: `zvd_validation_rule_groups` was read only
 * by its own CRUD, and this engine evaluated every rule on a field with AND,
 * unconditionally. So "either a VAT number or a registration number" — the case
 * the feature exists for — was expressible in the UI and could not work. The
 * write was refused citing a rule the group had said was optional.
 *
 * Note which way that failed: AND is the STRICTER reading, so no invalid record
 * ever got in. The damage was valid records refused and an administrator shown a
 * green, active group that was doing nothing.
 *
 * The table belongs to the `developer/validation` extension while
 * `zv_validation_rules` belongs to the engine, so this reads across a boundary
 * that points the wrong way. It is guarded rather than typed: absent table,
 * uninstalled extension, or any error means no groups and the previous
 * behaviour, which is the safe direction.
 *
 * Instance-wide since migration 091, like the rules: the cache below is keyed by
 * collection alone, and while the table was tenant-scoped one tenant's groups
 * were served to every other tenant's writes until it expired.
 */
/**
 * Does the extension's table exist? Asked once per process, not per write.
 *
 * `null` = not asked yet. The answer only changes when the extension is
 * installed or removed, which restarts the engine.
 */
const ruleGroupsTablePresent = new WeakMap<object, boolean>();

async function hasRuleGroupsTable(db: Database): Promise<boolean> {
  const known = ruleGroupsTablePresent.get(db as unknown as object);
  if (known !== undefined) return known;
  let present = false;
  try {
    const probe = await sql<{ present: boolean }>`
      SELECT to_regclass('zvd_validation_rule_groups') IS NOT NULL AS present
    `.execute(db);
    present = probe.rows[0]?.present === true;
  } catch {
    // This catch is not the one that caused the bug, and the difference is the
    // whole point: `to_regclass` returns NULL for a name that does not exist
    // rather than raising, so it cannot fail for the case being asked about and
    // cannot abort anything. A throw here means there is no usable database
    // at all — or a test handing over a stub that answers a fixed set of
    // queries — and "no groups" is then both the old behaviour and the strict
    // direction: every rule on a field stays required.
    present = false;
  }
  ruleGroupsTablePresent.set(db as unknown as object, present);
  return present;
}

/** Test seam — a test may create or drop the table under a handle it reuses. */
export function resetRuleGroupsTableProbe(db?: Database): void {
  if (db) ruleGroupsTablePresent.delete(db as unknown as object);
}

async function getRuleGroups(db: Database, collection: string): Promise<RuleGroup[]> {
  const cached = groupsCache.get(collection);
  if (cached && Date.now() - cached.ts < 60_000) return cached.groups;

  let groups: RuleGroup[] = [];
  // Ask whether the table is there instead of asking it a question and
  // catching the refusal.
  //
  // The refusal is `42P01`, and `42P01` ABORTS THE TRANSACTION. Catching it in
  // JavaScript does not undo that — every later statement on the connection
  // answers `25P02 current transaction is aborted`, including statements
  // belonging to a completely different request once the connection goes back
  // to the pool. Traced in CI: this query failed during
  // `POST /api/data/hist_probe_…`, and a later `GET` on the same collection
  // died on its FIRST statement, `select * from zvd_collections where name = $1`,
  // having done nothing wrong itself. E2E failed that way in 8 of 19 runs.
  //
  // `to_regclass` returns NULL rather than raising, so the probe cannot poison
  // anything, and the answer is cached for the life of the process: installing
  // or removing an extension restarts the engine.
  //
  if (await hasRuleGroupsTable(db)) {
    // Guarded even though the probe just said the table is there. The probe's
    // answer is cached for the life of the process, so it can be stale — a
    // migration during the run, or, in `bun test`, an earlier file that
    // answered the probe differently. A stale "present" would put us right back
    // to a failed statement inside somebody's transaction.
    groups = await withSavepoint(
      db,
      'zv_rule_groups',
      async () => {
        const rows = await sql<{ field_name: string; logic: string; rule_ids: string[] | null }>`
          SELECT field_name, logic, rule_ids
          FROM zvd_validation_rule_groups
          WHERE collection = ${collection} AND is_active = true
        `.execute(db);
        return rows.rows.map((r) => ({
          field_name: r.field_name,
          logic: String(r.logic ?? 'AND').toUpperCase(),
          rule_ids: toIdArray(r.rule_ids),
        }));
      },
      // No groups is the strict reading — every rule on a field stays required.
      () => [],
    );
  }
  groupsCache.set(collection, { groups, ts: Date.now() });
  return groups;
}

/** Every tenant's entries for `collection`: a rule write is rare, a reload cheap. */
export function invalidateRulesCache(collection: string): void {
  groupsCache.delete(collection);
  // L7 FIX: Use exact match + prefix with ':' separator to avoid "user" matching "users".
  for (const key of rulesCache.keys()) {
    if (key === collection || key.startsWith(`${collection}:`)) rulesCache.delete(key);
  }
}

/**
 * Validate a single field value against its rules.
 * Returns an array of error messages (empty = valid).
 */
/**
 * Executes a regex test in a Bun Worker thread to prevent ReDoS attacks.
 *
 * Running in a Worker thread means that a catastrophic backtracking pattern
 * cannot block the main event loop. If the test doesn't complete within
 * `timeoutMs`, the worker is terminated and `false` is returned.
 *
 * Falls back to a direct (unprotected) test in non-Bun environments where
 * the Worker constructor is unavailable.
 */
async function safeRegexTest(pattern: string, value: string, timeoutMs = 200): Promise<boolean> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return false;
  }

  // In Bun, run the test inside a Worker so a ReDoS pattern cannot freeze the server.
  if (typeof Worker !== 'undefined') {
    const workerCode = `
      self.onmessage = ({ data: { pattern, value } }) => {
        try {
          const result = new RegExp(pattern).test(value);
          self.postMessage({ result });
        } catch {
          self.postMessage({ result: false });
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        worker.terminate();
        resolve(false); // treat ReDoS timeout as non-match
      }, timeoutMs);

      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(Boolean(data?.result));
      };

      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        resolve(false);
      };

      worker.postMessage({ pattern, value });
    });
  }

  // Fallback for non-Worker environments (test environments, etc.)
  try {
    return regex.test(value);
  } catch {
    return false;
  }
}

export async function validateFieldValue(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  value: any,
  rules: ValidationRule[],
  /** The field's declared type; decides how an expression rule sees a number. */
  fieldType?: string,
  /**
   * The value stored before this write, for `transition` rules: `{ value: null }`
   * on create. Absent when the caller did not read the stored record, and then
   * a transition rule cannot be evaluated and refuses the write.
   */
  previous?: { value: unknown },
): Promise<string[]> {
  const errors: string[] = [];

  for (const rule of rules) {
    const cfg =
      typeof rule.rule_config === 'string' ? JSON.parse(rule.rule_config) : rule.rule_config;
    let violated = false;
    let misconfigured: string | null = null;

    switch (rule.rule_type) {
      case 'required':
        violated = value === null || value === undefined || value === '';
        break;
      case 'min':
        violated = typeof value === 'number' && value < cfg.value;
        break;
      case 'max':
        violated = typeof value === 'number' && value > cfg.value;
        break;
      case 'minLength':
        violated = typeof value === 'string' && value.length < cfg.value;
        break;
      case 'maxLength':
        violated = typeof value === 'string' && value.length > cfg.value;
        break;
      case 'pattern':
        // safeRegexTest runs in a Worker thread — await is required
        violated = typeof value === 'string' && !(await safeRegexTest(cfg.pattern, value));
        break;
      case 'range':
        violated = typeof value === 'number' && (value < cfg.min || value > cfg.max);
        break;
      case 'email':
        violated =
          typeof value === 'string' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        break;
      case 'url':
        try {
          if (value) new URL(value);
        } catch {
          violated = true;
        }
        break;
      case 'custom':
      case 'nlp': {
        const expression = String(cfg?.expression ?? '');
        if (expression === '') {
          misconfigured = 'has no expression';
          break;
        }
        const outcome = evaluateExpressionRule(expression, value, fieldType);
        if (outcome.status === 'refused') misconfigured = outcome.reason;
        else violated = outcome.status === 'failed';
        break;
      }
      case 'transition': {
        const expression = String(cfg?.expression ?? '');
        if (expression === '') {
          misconfigured = 'has no expression';
          break;
        }
        if (previous === undefined) {
          misconfigured =
            'is a transition rule without the stored value to compare with (this write path ' +
            'reads no stored record, the read withheld the column, or the field is encrypted)';
          break;
        }
        const outcome = evaluateTransitionRule(expression, value, previous.value, fieldType);
        if (outcome.status === 'refused') misconfigured = outcome.reason;
        else violated = outcome.status === 'failed';
        break;
      }
      default:
        misconfigured = `has rule type \`${rule.rule_type}\`, which this engine does not implement`;
    }

    // Fail CLOSED on a rule that cannot be evaluated. This used to log a
    // warning and pass — as did an unknown rule type or an expression-less
    // `nlp` rule, silently — so a constraint an administrator put in place
    // vanished while still listed as active. Only writes that touch this field
    // are refused, and the caller is told why without seeing the rule; the
    // details go to the log for the operator.
    if (misconfigured !== null) {
      console.error(
        `[validation-engine] rule ${rule.id ?? '(unsaved)'} on ${rule.field_name} cannot be ` +
          `evaluated: it ${misconfigured}; refusing the write`,
      );
      errors.push(
        'a validation rule on this field cannot be evaluated; an administrator must fix or deactivate it',
      );
      continue;
    }

    if (violated) errors.push(rule.error_message ?? `Validation failed: ${rule.rule_type}`);
  }

  return errors;
}

/**
 * Validate an entire record against all active rules for a collection.
 * Returns { valid, errors: { fieldName: [messages] } }
 */
export async function validateRecord(
  db: Database,
  collection: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  data: Record<string, any>,
  /** Declared type per field name, for expression rules; see validateFieldValue. */
  fieldTypes: ReadonlyMap<string, string> = new Map(),
  opts: {
    /**
     * The stored record for `transition` rules: `null` on create. Left out, a
     * transition rule on a field in `data` refuses the write.
     */
    previous?: Record<string, unknown> | null;
    /**
     * `skip` leaves transition rules out (the caller evaluates them once it has
     * read and locked the stored record); `only` evaluates nothing else.
     * Transition rules are not grouped: inside a group they are dropped from
     * it, and each must hold on its own.
     */
    transitions?: 'skip' | 'only';
    /**
     * Fields whose written and stored values cannot be compared (ciphertext,
     * locale-formatted `money`): a transition rule on them refuses.
     */
    opaque?: ReadonlySet<string>;
  } = {},
): Promise<{ valid: boolean; errors: Record<string, string[]> }> {
  const errors: Record<string, string[]> = {};
  const groups = await getRuleGroups(db, collection);

  for (const [fieldName, value] of Object.entries(data)) {
    const fieldRules = (await getValidationRules(db, collection, fieldName)).filter((r) =>
      opts.transitions === 'skip'
        ? r.rule_type !== 'transition'
        : opts.transitions !== 'only' || r.rule_type === 'transition',
    );
    const fieldType = fieldTypes.get(fieldName);
    // A stored record without this field (a column the read withheld) is as
    // good as no record: the rule cannot be evaluated, so it refuses.
    const previous = opts.opaque?.has(fieldName)
      ? undefined
      : opts.previous === null
        ? { value: null }
        : opts.previous && fieldName in opts.previous
          ? { value: opts.previous[fieldName] }
          : undefined;
    if (fieldRules.length === 0) continue;

    const fieldGroups = groups.filter((g) => g.field_name === fieldName);
    const grouped = new Set(fieldGroups.flatMap((g) => g.rule_ids));
    // Groups are instance-wide and combine instance rules only. A tenant's rule
    // is ANDed on top even when a group names its id: as a member of an OR
    // group it would satisfy the group for that tenant, and relax an instance rule.
    const groupable = (r: ValidationRule) =>
      r.id !== undefined && !r.tenant_id && r.rule_type !== 'transition';

    // Rules nobody grouped keep the old behaviour: all of them must hold.
    const ungrouped = fieldRules.filter((r) => !groupable(r) || !grouped.has(r.id ?? ''));
    const fieldErrors =
      ungrouped.length > 0 ? await validateFieldValue(value, ungrouped, fieldType, previous) : [];

    for (const group of fieldGroups) {
      const members = fieldRules.filter((r) => groupable(r) && group.rule_ids.includes(r.id ?? ''));
      if (members.length === 0) continue;
      if (group.logic === 'OR') {
        // Satisfying ONE member satisfies the group — "either a VAT number or a
        // registration number" is the case the feature exists for. Only when
        // every member fails does the group contribute, and then it contributes
        // all of their messages, because none of them is the one that had to hold.
        const perRule = await Promise.all(
          members.map((r) => validateFieldValue(value, [r], fieldType)),
        );
        if (perRule.every((e) => e.length > 0)) fieldErrors.push(...perRule.flat());
      } else {
        fieldErrors.push(...(await validateFieldValue(value, members, fieldType)));
      }
    }

    if (fieldErrors.length > 0) errors[fieldName] = fieldErrors;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

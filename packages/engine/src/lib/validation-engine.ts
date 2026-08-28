/**
 * Validation Engine
 *
 * Loads validation rules from zv_validation_rules, caches them in-memory for 60s,
 * and provides helpers to validate field values and entire records.
 * Uses expr-eval-fork for safe expression parsing (no eval/Function usage).
 */

import { Parser } from 'expr-eval-fork';
import { sql } from 'kysely';
import { withSavepoint } from './savepoint.js';
import type { Database } from '../db/index.js';

const parser = new Parser({
  operators: {
    logical: true,
    comparison: true,
    in: true,
    assignment: false, // disallow assignment for safety
  },
});

// expr-eval-fork@3 patches upstream expr-eval's prototype-pollution and
// unrestricted-functions advisories (the original is unmaintained at 2.0.2).
// The token guard stays as defense-in-depth: our Parser exposes only `{ value }`
// and a legitimate validation expression (comparisons/logic over `value`) never
// needs `constructor`/`__proto__`/`prototype` — reject them before parsing, so a
// tenant-admin-authored rule can't even attempt to pollute the shared process.
const UNSAFE_EXPR_TOKEN =
  /(__proto__|constructor|prototype|__define[GS]etter__|__lookup[GS]etter__)/;
function isSafeExpression(expr: string): boolean {
  return !UNSAFE_EXPR_TOKEN.test(expr);
}

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
 * Decide whether an expression may be stored at all.
 *
 * Two independent checks, because the blocklist alone is a guess about what an
 * attacker will type. Parsing with expr-eval is the load-bearing one: the
 * grammar has no property access, no calls to anything it was not given, and no
 * statements, so an expression that parses cannot express `process.exit(1)`
 * whether or not anyone thought to blocklist `process`.
 */
export function checkValidationExpression(
  expression: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isSafeExpression(expression)) {
    return { ok: false, reason: 'contains a blocked token (prototype-pollution vector)' };
  }
  let parsed: ReturnType<typeof parser.parse>;
  try {
    parsed = parser.parse(expression);
  } catch (err) {
    // Phrased to read after "The expression ..." in the extension's 400, which
    // is where a rule author sees it.
    return { ok: false, reason: `could not be parsed: ${(err as Error).message}` };
  }

  // Parsing alone is not enough to store an expression, only to run one safely.
  // `process.exit(1)` PARSES: expr-eval reads it as a call on a variable named
  // `process`, and refuses it at evaluation because nothing is bound to that
  // name. The process is never in danger — but a rule that can only ever be
  // refused would sit in the database looking configured, so the write path
  // needs the stricter test.
  //
  // An allowlist rather than a blocklist, because the set of names this scope
  // provides is one, and enumerating what an attacker might reach for is a game
  // with no end.
  const unknown = parsed.variables({ withMembers: false }).filter((v) => v !== 'value');
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `refers to ${unknown.map((v) => `\`${v}\``).join(', ')}, and the only value in ` +
        'scope is `value`',
    };
  }
  return { ok: true };
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
 */
export function evaluateExpressionRule(expression: string, value: unknown): ExpressionRuleResult {
  const check = checkValidationExpression(expression);
  if (!check.ok) return { status: 'refused', reason: check.reason };
  try {
    // expr-eval's scope type does not admit `unknown`. The cast sits at this
    // boundary rather than in the signature: callers pass whatever a column
    // holds, and narrowing here would push a cast onto every one of them.
    const scope = { value } as unknown as Parameters<
      ReturnType<typeof parser.parse>['evaluate']
    >[0];
    return parser.parse(expression).evaluate(scope) ? { status: 'passed' } : { status: 'failed' };
  } catch (err) {
    return { status: 'refused', reason: `could not be evaluated: ${(err as Error).message}` };
  }
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
  field_name: string;
  rule_type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

// In-memory rules cache (TTL 60s)
const rulesCache = new Map<string, { rules: ValidationRule[]; ts: number }>();

export async function getValidationRules(
  db: Database,
  collection: string,
  fieldName?: string,
): Promise<ValidationRule[]> {
  const cacheKey = `${collection}:${fieldName || '*'}`;
  const cached = rulesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.rules;

  let query = db
    .selectFrom('zv_validation_rules')
    .select(['id', 'field_name', 'rule_type', 'rule_config', 'error_message'])
    .where('collection', '=', collection)
    .where('is_active', '=', true);

  if (fieldName) query = query.where('field_name', '=', fieldName);

  // rule_config is JSONB → typed as unknown; coerce to the runtime contract.
  const rules: ValidationRule[] = (await query.execute()).map((row) => ({
    id: String(row.id),
    field_name: row.field_name,
    rule_type: row.rule_type,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    rule_config: (row.rule_config ?? {}) as Record<string, any>,
    error_message: row.error_message,
  }));
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
function toIdArray(value: unknown): string[] {
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
 * behaviour, which is the safe direction. The honest fix is to move the table
 * into the engine beside the rules it groups — a schema change to a table
 * holding customer configuration, and an owner's call rather than mine.
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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export async function validateFieldValue(value: any, rules: ValidationRule[]): Promise<string[]> {
  const errors: string[] = [];

  for (const rule of rules) {
    const cfg =
      typeof rule.rule_config === 'string' ? JSON.parse(rule.rule_config) : rule.rule_config;
    let violated = false;

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
      case 'nlp':
        if (cfg.expression) {
          const outcome = evaluateExpressionRule(String(cfg.expression), value);
          if (outcome.status === 'refused') {
            // Permissive on refusal, and logged. A rule the engine declines to
            // run must not start failing everyone's writes — but the operator
            // has to learn that a rule they configured is inert.
            console.warn(
              `[validation-engine] refused an expression rule on ${rule.field_name}: ` +
                `it ${outcome.reason}`,
            );
          } else {
            violated = outcome.status === 'failed';
          }
        }
        break;
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
): Promise<{ valid: boolean; errors: Record<string, string[]> }> {
  const errors: Record<string, string[]> = {};
  const groups = await getRuleGroups(db, collection);

  for (const [fieldName, value] of Object.entries(data)) {
    const fieldRules = await getValidationRules(db, collection, fieldName);
    if (fieldRules.length === 0) continue;

    const fieldGroups = groups.filter((g) => g.field_name === fieldName);
    const grouped = new Set(fieldGroups.flatMap((g) => g.rule_ids));

    // Rules nobody grouped keep the old behaviour: all of them must hold.
    const ungrouped = fieldRules.filter((r) => r.id === undefined || !grouped.has(r.id));
    const fieldErrors = ungrouped.length > 0 ? await validateFieldValue(value, ungrouped) : [];

    for (const group of fieldGroups) {
      const members = fieldRules.filter((r) => r.id !== undefined && group.rule_ids.includes(r.id));
      if (members.length === 0) continue;
      if (group.logic === 'OR') {
        // Satisfying ONE member satisfies the group — "either a VAT number or a
        // registration number" is the case the feature exists for. Only when
        // every member fails does the group contribute, and then it contributes
        // all of their messages, because none of them is the one that had to hold.
        const perRule = await Promise.all(members.map((r) => validateFieldValue(value, [r])));
        if (perRule.every((e) => e.length > 0)) fieldErrors.push(...perRule.flat());
      } else {
        fieldErrors.push(...(await validateFieldValue(value, members)));
      }
    }

    if (fieldErrors.length > 0) errors[fieldName] = fieldErrors;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validation Engine
 *
 * Loads validation rules from zv_validation_rules, caches them in-memory for 60s,
 * and provides helpers to validate field values and entire records.
 * Uses expr-eval-fork for safe expression parsing (no eval/Function usage).
 */

import { Parser } from 'expr-eval-fork';
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
    return { ok: false, reason: `is not a valid expression: ${(err as Error).message}` };
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
  field_name: string;
  rule_type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    .select(['field_name', 'rule_type', 'rule_config', 'error_message'])
    .where('collection', '=', collection)
    .where('is_active', '=', true);

  if (fieldName) query = query.where('field_name', '=', fieldName);

  // rule_config is JSONB → typed as unknown; coerce to the runtime contract.
  const rules: ValidationRule[] = (await query.execute()).map((row) => ({
    field_name: row.field_name,
    rule_type: row.rule_type,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    rule_config: (row.rule_config ?? {}) as Record<string, any>,
    error_message: row.error_message,
  }));
  rulesCache.set(cacheKey, { rules, ts: Date.now() });
  return rules;
}

export function invalidateRulesCache(collection: string): void {
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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
): Promise<{ valid: boolean; errors: Record<string, string[]> }> {
  const errors: Record<string, string[]> = {};

  for (const [fieldName, value] of Object.entries(data)) {
    const fieldRules = await getValidationRules(db, collection, fieldName);
    if (fieldRules.length === 0) continue;
    const fieldErrors = await validateFieldValue(value, fieldRules);
    if (fieldErrors.length > 0) errors[fieldName] = fieldErrors;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

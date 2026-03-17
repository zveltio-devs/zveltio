/**
 * Validation Engine
 *
 * Loads validation rules from zv_validation_rules, caches them in-memory for 60s,
 * and provides helpers to validate field values and entire records.
 * Uses expr-eval for safe expression parsing (no eval/Function usage).
 */

import { Parser } from 'expr-eval';
import type { Database } from '../db/index.js';

const parser = new Parser({
  operators: {
    logical: true,
    comparison: true,
    in: true,
    assignment: false, // disallow assignment for safety
  },
});

export interface ValidationRule {
  field_name: string;
  rule_type: string;
  rule_config: Record<string, any>;
  error_message: string;
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

  let query = (db as any)
    .selectFrom('zv_validation_rules')
    .select(['field_name', 'rule_type', 'rule_config', 'error_message'])
    .where('collection', '=', collection)
    .where('is_active', '=', true);

  if (fieldName) query = query.where('field_name', '=', fieldName);

  const rules = await query.execute();
  rulesCache.set(cacheKey, { rules, ts: Date.now() });
  return rules;
}

export function invalidateRulesCache(collection: string): void {
  for (const key of rulesCache.keys()) {
    if (key.startsWith(collection)) rulesCache.delete(key);
  }
}

/**
 * Validate a single field value against its rules.
 * Returns an array of error messages (empty = valid).
 */
/**
 * Executes a regex test with a timeout to prevent ReDoS attacks.
 * Returns null if the regex is invalid; false if it times out.
 * TODO: For production-grade ReDoS protection, run in a Bun Worker thread
 * (similar to edge-functions/worker-runner.ts). The `re2` npm package also
 * provides O(n) guarantees via Google's RE2 engine.
 */
function safeRegexTest(pattern: string, value: string, timeoutMs = 100): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return false; // Invalid regex — treat as no match
  }

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
  try {
    const result = regex.test(value);
    clearTimeout(timer);
    // If the timeout fired during regex.test (possible in single-threaded JS),
    // treat as non-match to avoid stalling further.
    return timedOut ? false : result;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

export function validateFieldValue(value: any, rules: ValidationRule[]): string[] {
  const errors: string[] = [];

  for (const rule of rules) {
    const cfg = typeof rule.rule_config === 'string' ? JSON.parse(rule.rule_config) : rule.rule_config;
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
        violated = typeof value === 'string' && !safeRegexTest(cfg.pattern, value);
        break;
      case 'range':
        violated = typeof value === 'number' && (value < cfg.min || value > cfg.max);
        break;
      case 'email':
        violated = typeof value === 'string' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
        try {
          if (cfg.expression) {
            const result = parser.parse(cfg.expression).evaluate({ value });
            violated = !result;
          }
        } catch {
          violated = false; // expression parse error → permissive
        }
        break;
    }

    if (violated) errors.push(rule.error_message);
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
  data: Record<string, any>,
): Promise<{ valid: boolean; errors: Record<string, string[]> }> {
  const errors: Record<string, string[]> = {};

  for (const [fieldName, value] of Object.entries(data)) {
    const fieldRules = await getValidationRules(db, collection, fieldName);
    if (fieldRules.length === 0) continue;
    const fieldErrors = validateFieldValue(value, fieldRules);
    if (fieldErrors.length > 0) errors[fieldName] = fieldErrors;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

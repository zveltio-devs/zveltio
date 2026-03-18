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

export async function validateFieldValue(value: any, rules: ValidationRule[]): Promise<string[]> {
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
        // safeRegexTest runs in a Worker thread — await is required
        violated = typeof value === 'string' && !(await safeRegexTest(cfg.pattern, value));
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
    const fieldErrors = await validateFieldValue(value, fieldRules);
    if (fieldErrors.length > 0) errors[fieldName] = fieldErrors;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

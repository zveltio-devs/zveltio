/**
 * flow-step-schemas.ts
 *
 * Zod schemas for each flow step type. Used to validate step `config` objects
 * at creation/update time rather than at execution time.
 *
 * Usage:
 *   import { validateStepConfig } from '../lib/flow-step-schemas.js';
 *   const result = validateStepConfig('send_email', req.body.config);
 *   if (!result.valid) return c.json({ error: 'Invalid config', errors: result.errors }, 400);
 */

import { z } from 'zod';

// ── Per-type schemas ──────────────────────────────────────────────────────────

export const stepSchemas = {

  /** Execute a JavaScript/TypeScript script in a sandboxed edge function */
  run_script: z.object({
    script:     z.string().min(1, 'Script is required'),
    timeout_ms: z.number().int().min(100).max(30_000).default(5_000),
  }),

  /** Send a transactional email via the configured mail provider */
  send_email: z.object({
    to:      z.union([z.string().email(), z.string().startsWith('{{')]),
    subject: z.string().min(1, 'Subject is required'),
    body:    z.string().min(1, 'Email body is required'),
    from:    z.string().optional(),
    cc:      z.string().optional(),
    bcc:     z.string().optional(),
  }),

  /** HTTP webhook call to an external URL */
  webhook: z.object({
    url:           z.union([z.string().url(), z.string().startsWith('{{')]),
    method:        z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers:       z.record(z.string(), z.string()).default({}),
    body_template: z.string().optional(),
    timeout_ms:    z.number().int().min(100).max(30_000).default(10_000),
  }),

  /** Conditional branching — evaluate an expression and follow true/false branch */
  condition: z.object({
    expression:   z.string().min(1, 'Condition expression is required'),
    true_branch:  z.array(z.string().uuid()).default([]),
    false_branch: z.array(z.string().uuid()).default([]),
  }),

  /** Pause execution for a fixed duration */
  delay: z.object({
    duration_ms: z.number().int().min(100).max(86_400_000), // max 24h
  }),

  /** Create a new record in a collection */
  create_record: z.object({
    collection: z.string().min(1),
    data:       z.record(z.string(), z.unknown()),
  }),

  /** Update an existing record in a collection */
  update_record: z.object({
    collection: z.string().min(1),
    id:         z.union([z.string().uuid(), z.string().startsWith('{{')]),
    data:       z.record(z.string(), z.unknown()),
  }),

  /** Delete a record from a collection */
  delete_record: z.object({
    collection: z.string().min(1),
    id:         z.union([z.string().uuid(), z.string().startsWith('{{')]),
  }),

  /** AI-based decision step — evaluates prompt and classifies outcome */
  ai_decision: z.object({
    prompt:       z.string().min(1, 'AI prompt is required'),
    model:        z.string().optional(),
    options:      z.array(z.string()).min(2, 'At least 2 decision options required'),
    context_keys: z.array(z.string()).default([]),
    timeout_ms:   z.number().int().min(1_000).max(60_000).default(15_000),
  }),

  /** Send an SMS message via the configured SMS provider */
  send_sms: z.object({
    to:      z.union([z.string(), z.string().startsWith('{{')]),
    message: z.string().min(1).max(1600),
    from:    z.string().optional(),
  }),

  /** Transform data using a template or expression */
  transform: z.object({
    template: z.record(z.string(), z.unknown()),
  }),

  /** Loop over an array and execute sub-steps for each item */
  loop: z.object({
    items_key:  z.string().min(1, 'items_key is required (path to array in context)'),
    item_alias: z.string().default('item'),
    steps:      z.array(z.string().uuid()).default([]),
    max_iterations: z.number().int().min(1).max(1000).default(100),
  }),

} as const;

export type StepType = keyof typeof stepSchemas;

// ── Validation helper ─────────────────────────────────────────────────────────

export interface StepValidationResult {
  valid: boolean;
  errors: string[];
  /** Parsed and coerced config (with Zod defaults applied) — only set when valid */
  config?: Record<string, unknown>;
}

/**
 * Validates a step config object against the schema for the given step type.
 *
 * @param type   - Step type string (e.g. 'send_email', 'run_script')
 * @param config - Raw config object from the request body
 * @returns      - Validation result with error messages if invalid
 */
export function validateStepConfig(type: string, config: unknown): StepValidationResult {
  const schema = stepSchemas[type as StepType];

  if (!schema) {
    return {
      valid: false,
      errors: [`Unknown step type: "${type}". Valid types: ${Object.keys(stepSchemas).join(', ')}`],
    };
  }

  const result = schema.safeParse(config ?? {});

  if (result.success) {
    return { valid: true, errors: [], config: result.data as Record<string, unknown> };
  }

  const errors = result.error.issues.map((e) => {
    const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
    return `${path}${e.message}`;
  });

  return { valid: false, errors };
}

/**
 * Returns true if the given string is a known step type.
 */
export function isKnownStepType(type: string): type is StepType {
  return type in stepSchemas;
}

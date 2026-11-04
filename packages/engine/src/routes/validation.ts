/**
 * Validation rule administration, `/api/validation`. Tenant admins only; the
 * engine evaluates the rules on every write (lib/validation-engine.ts).
 *
 * POST   /generate                        AI → a rule to review (instance admin)
 * GET    /rules                           rules this tenant answers to (?collection=)
 * POST   /rules                           create a rule
 * PATCH  /rules/:id                       toggle is_active
 * DELETE /rules/:id                       delete a rule
 * POST   /rules/import                    create many rules: { collection, rules: [] }
 * GET    /rules/:id/test-cases            a rule's test cases
 * POST   /rules/:id/test-cases            add one
 * DELETE /rules/:id/test-cases/:testId    delete one
 * POST   /rules/:id/test-cases/run        run a rule's test cases
 * POST   /test-cases/run                  run every test case of { collection }
 * GET    /groups                          rule groups (?collection=)
 * POST   /groups                          create a group (instance admin)
 * DELETE /groups/:id                      delete a group (instance admin)
 *
 * Rules and groups bind every tenant, so the engine writes them
 * (lib/validation-writes.ts): an instance admin writes instance rules and
 * groups, a tenant admin only their own tenant's rules, which add to the
 * instance's. Test cases and the import log are the tenant's rows (RLS). This
 * was the `developer/validation` extension until it was retired.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { guardAdmin, type SessionSource } from '../lib/admin-guard.js';
import { DDLManager } from '../lib/data/index.js';
import { toJsonb } from '../lib/jsonb.js';
import { reqDb } from '../lib/route-db.js';
import { serviceRegistry } from '../lib/service-registry.js';
import { isTenantAdmin, requireInstanceAdmin } from '../lib/tenancy/index.js';
import {
  checkValidationExpression,
  evaluateExpressionRule,
  evaluateTransitionRule,
  safeRegexTest,
} from '../lib/validation-engine.js';
import {
  type ValidationWriter,
  writeValidationRule,
  writeValidationRuleGroup,
} from '../lib/validation-writes.js';

const RULE_TYPES = [
  'required',
  'minLength',
  'maxLength',
  'min',
  'max',
  'email',
  'url',
  'pattern',
  'range',
  'nlp',
  'transition',
] as const;

const RuleConfigSchema = z.union([
  z.object({ value: z.number() }), // min, max, minLength, maxLength
  z.object({ pattern: z.string() }), // pattern
  z.object({ min: z.number(), max: z.number() }), // range
  z.object({ expression: z.string() }), // nlp, transition
  z.object({}).passthrough(), // required / email / url (empty config)
]);

const RuleSchema = z.object({
  field_name: z.string().min(1).max(100),
  rule_type: z.enum(RULE_TYPES),
  rule_config: RuleConfigSchema.default({}),
  error_message: z.string().min(1).max(500),
  nl_description: z.string().optional(),
});
type RuleInput = z.infer<typeof RuleSchema>;

const RuleCreateSchema = RuleSchema.extend({ collection: z.string().min(1).max(100) });

const RuleUpdateSchema = z.object({
  // Studio SDUI editable cells send string option values; coerce so toggles work.
  is_active: z.union([
    z.boolean(),
    z.literal('true').transform(() => true),
    z.literal('false').transform(() => false),
  ]),
});

const ImportSchema = z.object({
  collection: z.string().min(1).max(100),
  rules: z.array(z.unknown()),
});

const TestCaseCreateSchema = z.object({
  label: z.string().min(1).max(200),
  input_value: z.string(),
  // For a `transition` rule: the stored value the test moves from. Left out,
  // the case is a create (`previous` is null).
  previous_value: z.string().nullable().optional(),
  expected_result: z.boolean(),
});

const RuleGroupCreateSchema = z.object({
  name: z.string().min(1).max(100),
  collection: z.string().min(1).max(100),
  field_name: z.string().min(1).max(100),
  description: z.string().optional(),
  logic: z.enum(['AND', 'OR']).default('AND'),
  rule_ids: z.array(z.string().uuid()),
  is_active: z.boolean().default(true),
});

/**
 * Does a test case's text input pass the rule? The expression rules go through
 * the engine's own evaluators, as the write path runs them; refused is not passed.
 */
async function applyRule(
  ruleType: string,
  // biome-ignore lint/suspicious/noExplicitAny: rule_config is per-type JSON
  cfg: any,
  input: string,
  previous: string | null,
  fieldType: string | undefined,
): Promise<boolean> {
  try {
    switch (ruleType) {
      case 'required':
        return input !== '';
      case 'minLength':
        return input.length >= (cfg.value ?? 0);
      case 'maxLength':
        return input.length <= (cfg.value ?? Number.POSITIVE_INFINITY);
      case 'min':
        return Number(input) >= (cfg.value ?? Number.NEGATIVE_INFINITY);
      case 'max':
        return Number(input) <= (cfg.value ?? Number.POSITIVE_INFINITY);
      case 'email':
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
      case 'url':
        return /^https?:\/\//.test(input);
      case 'pattern':
        return await safeRegexTest(String(cfg.pattern ?? ''), input);
      case 'range':
        return (
          Number(input) >= (cfg.min ?? Number.NEGATIVE_INFINITY) &&
          Number(input) <= (cfg.max ?? Number.POSITIVE_INFINITY)
        );
      case 'nlp':
        return (
          evaluateExpressionRule(String(cfg.expression ?? ''), input, fieldType).status === 'passed'
        );
      case 'transition':
        return (
          evaluateTransitionRule(String(cfg.expression ?? ''), input, previous, fieldType)
            .status === 'passed'
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Why an expression rule must not be stored, or null when it may. */
function expressionRefusal(rule: RuleInput): string | null {
  if (rule.rule_type !== 'nlp' && rule.rule_type !== 'transition') return null;
  const expression = String((rule.rule_config as { expression?: unknown }).expression ?? '');
  if (expression === '') return `A ${rule.rule_type} rule needs an \`expression\`.`;
  // The rule type decides the scope: a transition rule also sees `previous`.
  const verdict = checkValidationExpression(expression, rule.rule_type);
  return verdict.ok ? null : `The expression ${verdict.reason}.`;
}

type Env = { Variables: { userId: string } };

export function validationRoutes(db: Database, auth: SessionSource): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const user = await guardAdmin(c, auth, isTenantAdmin);
    if (user instanceof Response) return user;
    c.set('userId', user.id);
    await next();
  });

  const tenantOf = (c: Context<Env>): string | null =>
    (c.get('tenant') as { id?: string } | null | undefined)?.id ?? null;
  const writer = (c: Context<Env>): ValidationWriter => ({
    user: { id: c.get('userId') },
    trx: (c.get('tenantTrx') as Database | null | undefined) ?? undefined,
    tenantId: tenantOf(c),
  });
  const instanceAdmin = (c: Context<Env>) => requireInstanceAdmin(c.get('userId'));
  const ADMIN_REQUIRED = { error: 'Instance admin access required' } as const;

  /** The writer's refusals are errors: 409 on 098's instance key, else 403. */
  const writeRule = async (
    c: Context<Env>,
    write: Parameters<typeof writeValidationRule>[1],
  ): Promise<{ rule: Record<string, unknown> | null } | { refused: string; status: 403 | 409 }> => {
    try {
      return { rule: await writeValidationRule(writer(c), write) };
    } catch (err) {
      const errno = (err as { errno?: string }).errno;
      return {
        refused: err instanceof Error ? err.message : String(err),
        status: (errno === '23505' ? 409 : 403) as 403 | 409,
      };
    }
  };

  /** A rule this request answers to — an instance rule or its tenant's — or null. */
  const visibleRule = async (c: Context<Env>, id: string) => {
    const tenant = tenantOf(c);
    const r = await sql<{
      id: string;
      collection: string;
      field_name: string;
      rule_type: string;
      rule_config: unknown;
    }>`
      SELECT id, collection, field_name, rule_type, rule_config FROM zv_validation_rules
       WHERE id = ${id} AND (tenant_id IS NULL OR tenant_id = ${tenant}::uuid)`.execute(
      reqDb(c, db),
    );
    return r.rows[0] ?? null;
  };

  /** Each field's type in `collection`, which the expression evaluators type input by. */
  const fieldTypes = async (c: Context<Env>, collection: string) => {
    const coll = await DDLManager.getCollection(reqDb(c, db), collection);
    return new Map<string, string>(
      (coll?.fields ?? []).map((f: { name: string; type: string }) => [f.name, f.type]),
    );
  };

  /** Run test cases, record each outcome on its row, and answer the tally. */
  const runCases = async (
    c: Context<Env>,
    collection: string,
    rows: Array<{
      rule_id: string;
      rule_type: string;
      rule_config: unknown;
      field_name: string;
      tc_id: string;
      label: string;
      input_value: string;
      previous_value: string | null;
      expected_result: boolean;
    }>,
  ) => {
    const types = await fieldTypes(c, collection);
    const now = new Date();
    const results = [];
    for (const row of rows) {
      const cfg =
        typeof row.rule_config === 'string' ? JSON.parse(row.rule_config) : row.rule_config;
      const actual = await applyRule(
        row.rule_type,
        cfg ?? {},
        row.input_value,
        row.previous_value,
        types.get(row.field_name),
      );
      results.push({
        rule_id: row.rule_id,
        id: row.tc_id,
        label: row.label,
        input_value: row.input_value,
        expected: row.expected_result,
        actual,
        passed: actual === row.expected_result,
      });
      await sql`
        UPDATE zvd_validation_test_cases SET last_run_result = ${actual}, last_run_at = ${now}
         WHERE id = ${row.tc_id}`.execute(reqDb(c, db));
    }
    const passed = results.filter((r) => r.passed).length;
    return { total: results.length, passed, failed: results.length - passed, results };
  };

  app.post('/generate', async (c) => {
    if (!(await instanceAdmin(c))) return c.json(ADMIN_REQUIRED, 403);
    const { field_name, field_type, description } = await c.req.json();
    if (!description) return c.json({ error: 'description required' }, 400);

    const systemPrompt = `You are a validation rule generator for a BaaS platform.
Convert natural language validation descriptions into structured JSON rules.

Output ONLY valid JSON, no markdown, no explanation. Format:
{
  "rule_type": "required|min|max|minLength|maxLength|pattern|range|email|url|nlp",
  "rule_config": { ... },
  "error_message": "Human readable error in same language as input"
}

For range: rule_config = { "min": number, "max": number }
For min/max: rule_config = { "value": number }
For minLength/maxLength: rule_config = { "value": number }
For pattern: rule_config = { "pattern": "regex string" }
For nlp (complex): rule_config = { "expression": "CEL boolean expression using 'value'" }`;

    type ChatProvider = {
      chat?: (messages: unknown[], opts?: unknown) => Promise<{ content?: string }>;
      /** `ai` hands out a per-firm stand-in, never null; this says whether the firm has one. */
      configured?: () => Promise<boolean>;
    };
    const provider = serviceRegistry
      .get<{ getDefault(): ChatProvider | null }>('ai.providers')
      ?.getDefault();
    if (!provider?.chat || (await provider.configured?.()) === false) {
      return c.json({ error: 'AI extension is not active or no AI provider is configured' }, 503);
    }
    try {
      const response = await provider.chat(
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Field: ${field_name} (type: ${field_type || 'text'})\nDescription: ${description}`,
          },
        ],
        { temperature: 0.2 },
      );
      const parsed = JSON.parse((response.content ?? '').replace(/```json?|```/g, '').trim());
      return c.json({
        rule_type: parsed.rule_type,
        rule_config: parsed.rule_config,
        error_message: parsed.error_message,
        nl_description: description,
        preview: `If saved, this rule will enforce: ${parsed.error_message}`,
      });
    } catch (err) {
      return c.json({ error: 'AI generation failed', details: String(err) }, 500);
    }
  });

  app.get('/rules', async (c) => {
    const tenant = tenantOf(c);
    const collection = c.req.query('collection');
    let q = reqDb(c, db)
      .selectFrom('zv_validation_rules')
      .selectAll()
      .where((eb) =>
        tenant
          ? eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', tenant)])
          : eb('tenant_id', 'is', null),
      )
      .orderBy('created_at', 'desc');
    if (collection) q = q.where('collection', '=', collection);
    const rules = await q.execute();
    // Instance rules bind every tenant; a tenant's own only tighten. Say which.
    return c.json({
      data: rules.map((r) => ({ ...r, scope: r.tenant_id ? 'tenant' : 'instance' })),
    });
  });

  app.post('/rules', zValidator('json', RuleCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const refusal = expressionRefusal(body);
    if (refusal) return c.json({ error: refusal }, 400);
    const r = await writeRule(c, {
      op: 'create',
      rule: { ...body, nl_description: body.nl_description || null },
    });
    if ('refused' in r) return c.json({ error: r.refused }, r.status);
    return c.json({ rule: r.rule }, 201);
  });

  app.post('/rules/import', zValidator('json', ImportSchema), async (c) => {
    const { collection, rules } = c.req.valid('json');
    let imported = 0;
    const errors: Array<{ index: number; error: string }> = [];
    for (const [index, raw] of rules.entries()) {
      const parsed = RuleSchema.safeParse(raw);
      // The same guard as POST /rules: a bulk path is a write path.
      const error = parsed.success ? expressionRefusal(parsed.data) : parsed.error.message;
      if (error || !parsed.success) {
        errors.push({ index, error: error ?? 'invalid rule' });
        continue;
      }
      // Each rule in a savepoint of its own: one refused does not fail the rest.
      const r = await writeRule(c, {
        op: 'create',
        rule: { ...parsed.data, collection, nl_description: parsed.data.nl_description || null },
      });
      if ('refused' in r) errors.push({ index, error: r.refused });
      else imported++;
    }
    await sql`
      INSERT INTO zvd_validation_import_log
        (collection, imported_count, failed_count, errors, created_by)
      VALUES (${collection}, ${imported}, ${errors.length}, ${toJsonb(errors)},
              ${c.get('userId')})`.execute(reqDb(c, db));
    return c.json({ imported, failed: errors.length, errors }, imported > 0 ? 201 : 422);
  });

  app.patch('/rules/:id', zValidator('json', RuleUpdateSchema), async (c) => {
    const r = await writeRule(c, {
      op: 'setActive',
      id: c.req.param('id'),
      is_active: c.req.valid('json').is_active,
    });
    if ('refused' in r) return c.json({ error: r.refused }, 403);
    if (!r.rule) return c.json({ error: 'Not found' }, 404);
    return c.json({ rule: r.rule });
  });

  app.delete('/rules/:id', async (c) => {
    const r = await writeRule(c, { op: 'delete', id: c.req.param('id') });
    if ('refused' in r) return c.json({ error: r.refused }, 403);
    if (!r.rule) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/rules/:id/test-cases', async (c) => {
    const id = c.req.param('id');
    // Another tenant's rule is not found here, not answered with an empty list.
    if (!(await visibleRule(c, id))) return c.json({ error: 'Rule not found' }, 404);
    const rows = await sql`
      SELECT * FROM zvd_validation_test_cases WHERE rule_id = ${id}
       ORDER BY created_at ASC`.execute(reqDb(c, db));
    return c.json({ test_cases: rows.rows });
  });

  app.post('/rules/:id/test-cases', zValidator('json', TestCaseCreateSchema), async (c) => {
    const id = c.req.param('id');
    if (!(await visibleRule(c, id))) return c.json({ error: 'Rule not found' }, 404);
    const body = c.req.valid('json');
    const row = await sql`
      INSERT INTO zvd_validation_test_cases
        (rule_id, label, input_value, previous_value, expected_result, created_by)
      VALUES (${id}, ${body.label}, ${body.input_value}, ${body.previous_value ?? null},
              ${body.expected_result}, ${c.get('userId')})
      RETURNING *`.execute(reqDb(c, db));
    return c.json({ test_case: row.rows[0] }, 201);
  });

  app.delete('/rules/:id/test-cases/:testId', async (c) => {
    const res = await sql`
      DELETE FROM zvd_validation_test_cases
       WHERE id = ${c.req.param('testId')} AND rule_id = ${c.req.param('id')}`.execute(
      reqDb(c, db),
    );
    if (!res.numAffectedRows) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/rules/:id/test-cases/run', async (c) => {
    const rule = await visibleRule(c, c.req.param('id'));
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    const cases = await sql<{
      id: string;
      label: string;
      input_value: string;
      previous_value: string | null;
      expected_result: boolean;
    }>`
      SELECT id, label, input_value, previous_value, expected_result
        FROM zvd_validation_test_cases WHERE rule_id = ${rule.id}
       ORDER BY created_at ASC`.execute(reqDb(c, db));
    const rows = cases.rows.map((tc) => ({
      ...tc,
      tc_id: tc.id,
      rule_id: rule.id,
      rule_type: rule.rule_type,
      rule_config: rule.rule_config,
      field_name: rule.field_name,
    }));
    return c.json(await runCases(c, rule.collection, rows));
  });

  app.post(
    '/test-cases/run',
    zValidator('json', z.object({ collection: z.string().min(1).max(100) })),
    async (c) => {
      const { collection } = c.req.valid('json');
      const rows = await sql<Parameters<typeof runCases>[2][number]>`
        SELECT r.id AS rule_id, r.rule_type, r.rule_config, r.field_name,
               tc.id AS tc_id, tc.label, tc.input_value, tc.previous_value, tc.expected_result
          FROM zv_validation_rules r
          JOIN zvd_validation_test_cases tc ON tc.rule_id = r.id
         WHERE r.collection = ${collection}
           AND (r.tenant_id IS NULL OR r.tenant_id = ${tenantOf(c)}::uuid)
         ORDER BY tc.created_at ASC`.execute(reqDb(c, db));
      return c.json(await runCases(c, collection, rows.rows));
    },
  );

  app.get('/groups', async (c) => {
    const collection = c.req.query('collection');
    const rows = collection
      ? await sql`SELECT * FROM zvd_validation_rule_groups WHERE collection = ${collection}
                   ORDER BY name ASC`.execute(reqDb(c, db))
      : await sql`SELECT * FROM zvd_validation_rule_groups
                   ORDER BY collection ASC, name ASC`.execute(reqDb(c, db));
    return c.json({ groups: rows.rows });
  });

  // A group changes how the instance's rules combine, so it is the instance's too.
  app.post('/groups', zValidator('json', RuleGroupCreateSchema), async (c) => {
    if (!(await instanceAdmin(c))) return c.json(ADMIN_REQUIRED, 403);
    try {
      const group = await writeValidationRuleGroup(writer(c), {
        op: 'create',
        group: c.req.valid('json'),
      });
      return c.json({ group }, 201);
    } catch (err) {
      // SQLSTATE is on errno: a name is unique per collection.
      const errno = (err as { errno?: string }).errno;
      if (errno === '23505') {
        return c.json({ error: 'A group with this name already exists on this collection' }, 409);
      }
      // Any other database error is the engine's; the writer's refusals carry none.
      if (errno) throw err;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/groups/:id', async (c) => {
    if (!(await instanceAdmin(c))) return c.json(ADMIN_REQUIRED, 403);
    const removed = await writeValidationRuleGroup(writer(c), {
      op: 'delete',
      id: c.req.param('id'),
    });
    if (!removed) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}

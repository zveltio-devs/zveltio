/**
 * Data Validation Rules
 *
 * POST   /api/validation/generate      — AI → structured rule (admin)
 * GET    /api/validation/:collection   — list rules for collection
 * POST   /api/validation/:collection   — add rule (admin)
 * PATCH  /api/validation/:collection/:id — toggle active (admin)
 * DELETE /api/validation/:collection/:id — delete rule (admin)
 */

import { Hono } from 'hono';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { auth } from '../../../../packages/engine/src/lib/auth.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import { invalidateRulesCache } from '../../../../packages/engine/src/lib/validation-engine.js';

export function validationRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // POST /generate — convert NL description to structured rule (before /:collection)
  app.post('/generate', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const { collection, field_name, field_type, description } = await c.req.json();
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
For nlp (complex): rule_config = { "expression": "JavaScript boolean expression using 'value'" }`;

    const userMessage = `Field: ${field_name} (type: ${field_type || 'text'})\nDescription: ${description}`;

    try {
      const { aiProviderManager } = await import('../../../../packages/engine/src/lib/ai-provider.js');
      const provider = aiProviderManager.getDefault();
      if (!provider) return c.json({ error: 'No AI provider configured' }, 503);

      const response = await provider.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        { temperature: 0.2 },
      );

      const text = response.content || '';
      const parsed = JSON.parse(text.replace(/```json?|```/g, '').trim());

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

  // GET /:collection — list rules
  app.get('/:collection', async (c) => {
    const collection = c.req.param('collection');
    const rules = await (db as any)
      .selectFrom('zv_validation_rules')
      .selectAll()
      .where('collection', '=', collection)
      .orderBy('field_name', 'asc')
      .execute();
    return c.json({ rules });
  });

  // POST /:collection — add rule
  app.post('/:collection', async (c) => {
    const user = c.get('user');
    const collection = c.req.param('collection');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = await c.req.json();
    const rule = await (db as any)
      .insertInto('zv_validation_rules')
      .values({
        collection,
        field_name: body.field_name,
        rule_type: body.rule_type,
        nl_description: body.nl_description || null,
        rule_config: JSON.stringify(body.rule_config || {}),
        error_message: body.error_message,
        is_active: true,
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirst();

    invalidateRulesCache(collection);
    return c.json({ rule }, 201);
  });

  // PATCH /:collection/:id — toggle active
  app.patch('/:collection/:id', async (c) => {
    const user = c.get('user');
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = await c.req.json();
    const rule = await (db as any)
      .updateTable('zv_validation_rules')
      .set({ is_active: body.is_active, updated_at: new Date() })
      .where('id', '=', id)
      .where('collection', '=', collection)
      .returningAll()
      .executeTakeFirst();

    invalidateRulesCache(collection);
    return c.json({ rule });
  });

  // DELETE /:collection/:id — remove rule
  app.delete('/:collection/:id', async (c) => {
    const user = c.get('user');
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    await (db as any).deleteFrom('zv_validation_rules').where('id', '=', id).execute();
    invalidateRulesCache(collection);
    return c.json({ success: true });
  });

  return app;
}

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { runFunction } from '../lib/edge-functions/sandbox.js';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const DEFAULT_CODE = `// Edge function — runs inside the Zveltio engine
// Available: fetch, Request, Response, URL, console, crypto

export default async function handler(ctx) {
  const body = await ctx.request.json().catch(() => ({}));

  return Response.json({
    message: "Hello from edge!",
    input: body,
    env: ctx.env,
  });
}
`;

export function edgeFunctionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // ─── Admin CRUD ────────────────────────────────────────────────

  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const fns = await db
      .selectFrom('zv_edge_functions')
      .select(['id', 'name', 'display_name', 'description', 'http_method', 'path', 'is_active', 'runtime', 'created_at'])
      .orderBy('name', 'asc')
      .execute();

    return c.json({ functions: fns });
  });

  app.get('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const fn = await db
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!fn) return c.json({ error: 'Function not found' }, 404);
    return c.json({ function: fn });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/).min(1),
        display_name: z.string().min(1),
        description: z.string().optional(),
        code: z.string().default(''),
        http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']).default('POST'),
        timeout_ms: z.number().int().min(100).max(300000).default(30000),
        env_vars: z.record(z.string()).default({}),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const path = `/api/fn/${body.name}`;

      const fn = await db
        .insertInto('zv_edge_functions')
        .values({
          name: body.name,
          display_name: body.display_name,
          description: body.description,
          code: body.code || DEFAULT_CODE,
          http_method: body.http_method,
          path,
          timeout_ms: body.timeout_ms,
          env_vars: JSON.stringify(body.env_vars),
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ function: fn }, 201);
    },
  );

  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        display_name: z.string().optional(),
        description: z.string().optional(),
        code: z.string().optional(),
        http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']).optional(),
        is_active: z.boolean().optional(),
        timeout_ms: z.number().optional(),
        env_vars: z.record(z.string()).optional(),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const updates: any = { updated_at: new Date() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) {
          updates[k] = k === 'env_vars' ? JSON.stringify(v) : v;
        }
      }

      const fn = await db
        .updateTable('zv_edge_functions')
        .set(updates)
        .where('id', '=', c.req.param('id'))
        .returningAll()
        .executeTakeFirst();

      if (!fn) return c.json({ error: 'Function not found' }, 404);
      return c.json({ function: fn });
    },
  );

  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.deleteFrom('zv_edge_functions').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // GET /:id/logs — invocation history
  app.get('/:id/logs', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const logs = await db
      .selectFrom('zv_edge_function_logs')
      .select(['id', 'status', 'duration_ms', 'error', 'created_at'])
      .where('function_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();

    return c.json({ logs });
  });

  // POST /:id/invoke — test invoke from Studio
  app.post('/:id/invoke', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const fn = await db
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!fn) return c.json({ error: 'Function not found' }, 404);

    const bodyText = await c.req.text();
    const testRequest = new Request(`http://localhost${fn.path}`, {
      method: fn.http_method === 'ANY' ? 'POST' : fn.http_method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyText || '{}',
    });

    const env = typeof fn.env_vars === 'string' ? JSON.parse(fn.env_vars) : fn.env_vars;
    const result = await runFunction(fn.code, testRequest, env, fn.timeout_ms);

    // Log invocation
    await db.insertInto('zv_edge_function_logs').values({
      function_id: fn.id,
      status: result.status,
      duration_ms: result.duration_ms,
      request_body: bodyText,
      response_body: result.body,
      error: result.error || null,
    }).execute().catch(() => {});

    return c.json({ result });
  });

  return app;
}

/**
 * Dynamically mount all active edge functions at their configured paths.
 * Called during engine startup.
 */
export async function mountEdgeFunctions(app: any, db: Database): Promise<void> {
  let fns: any[];
  try {
    fns = await db
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('is_active', '=', true)
      .execute();
  } catch {
    return; // Table might not exist yet on first boot
  }

  for (const fn of fns) {
    const method = fn.http_method === 'ANY' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [fn.http_method];
    const env = typeof fn.env_vars === 'string' ? JSON.parse(fn.env_vars) : fn.env_vars;

    app.on(method, fn.path, async (c: any) => {
      if (!fn.is_active) return c.json({ error: 'Function is inactive' }, 503);

      const result = await runFunction(fn.code, c.req.raw, env, fn.timeout_ms);

      // Log async
      db.insertInto('zv_edge_function_logs').values({
        function_id: fn.id,
        status: result.status,
        duration_ms: result.duration_ms,
        error: result.error || null,
      }).execute().catch(() => {});

      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  console.log(`  Edge functions mounted: ${fns.length}`);
}

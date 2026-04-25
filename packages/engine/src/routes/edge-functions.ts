import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { runEdgeFunction, type EdgeRequest } from '../lib/edge-function-runner.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function edgeFunctionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — list functions
  app.get('/', async (c) => {
    const fns = await (db as any)
      .selectFrom('zv_edge_functions')
      .select(['id', 'name', 'display_name', 'description', 'runtime', 'http_method', 'path', 'is_active', 'timeout_ms', 'created_at', 'updated_at'])
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ functions: fns });
  });

  // POST / — create function
  app.post(
    '/',
    zValidator('json', z.object({
      name:         z.string().min(1).max(100).regex(/^[a-z0-9-_]+$/, 'name must be URL-safe lowercase'),
      display_name: z.string().min(1).max(200),
      description:  z.string().optional(),
      code:         z.string().min(1),
      http_method:  z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']).default('POST'),
      timeout_ms:   z.number().int().min(100).max(60000).default(30000),
      env_vars:     z.record(z.string(), z.string()).default({}),
      is_active:    z.boolean().default(true),
    })),
    async (c) => {
      const body = c.req.valid('json');
      const existing = await (db as any)
        .selectFrom('zv_edge_functions').select('id')
        .where('name', '=', body.name).executeTakeFirst();
      if (existing) return c.json({ error: 'Function name already exists' }, 409);

      const fn = await (db as any)
        .insertInto('zv_edge_functions')
        .values({
          name:         body.name,
          display_name: body.display_name,
          description:  body.description,
          code:         body.code,
          http_method:  body.http_method,
          path:         `/api/fn/${body.name}`,
          timeout_ms:   body.timeout_ms,
          env_vars:     JSON.stringify(body.env_vars),
          is_active:    body.is_active,
          created_by:   (c as any).get('user').id,
        })
        .returningAll()
        .executeTakeFirst();
      return c.json({ function: fn }, 201);
    },
  );

  // GET /:id — get by ID
  app.get('/:id', async (c) => {
    const fn = await (db as any)
      .selectFrom('zv_edge_functions').selectAll()
      .where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!fn) return c.json({ error: 'Not found' }, 404);
    return c.json({ function: fn });
  });

  // PATCH /:id — update
  app.patch(
    '/:id',
    zValidator('json', z.object({
      display_name: z.string().optional(),
      description:  z.string().optional(),
      code:         z.string().optional(),
      http_method:  z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']).optional(),
      timeout_ms:   z.number().int().min(100).max(60000).optional(),
      env_vars:     z.record(z.string(), z.string()).optional(),
      is_active:    z.boolean().optional(),
    })),
    async (c) => {
      const body = c.req.valid('json');
      const updates: any = { updated_at: new Date() };
      if (body.display_name !== undefined) updates.display_name = body.display_name;
      if (body.description  !== undefined) updates.description  = body.description;
      if (body.code         !== undefined) updates.code         = body.code;
      if (body.http_method  !== undefined) updates.http_method  = body.http_method;
      if (body.timeout_ms   !== undefined) updates.timeout_ms   = body.timeout_ms;
      if (body.env_vars     !== undefined) updates.env_vars     = JSON.stringify(body.env_vars);
      if (body.is_active    !== undefined) updates.is_active    = body.is_active;

      const fn = await (db as any)
        .updateTable('zv_edge_functions').set(updates)
        .where('id', '=', c.req.param('id')).returningAll().executeTakeFirst();
      if (!fn) return c.json({ error: 'Not found' }, 404);
      return c.json({ function: fn });
    },
  );

  // DELETE /:id
  app.delete('/:id', async (c) => {
    await (db as any).deleteFrom('zv_edge_functions').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // GET /:id/logs
  app.get('/:id/logs', async (c) => {
    const { limit = '50' } = c.req.query();
    const logs = await (db as any)
      .selectFrom('zv_edge_function_logs').selectAll()
      .where('function_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 200))
      .execute();
    return c.json({ logs });
  });

  // POST /:id/invoke — test invocation from Studio (admin session)
  app.post('/:id/invoke', async (c) => {
    const fn = await (db as any)
      .selectFrom('zv_edge_functions').selectAll()
      .where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!fn) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const request: EdgeRequest = {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      query:   {},
      body,
      path:    fn.path,
    };

    const envVars = typeof fn.env_vars === 'string' ? JSON.parse(fn.env_vars) : (fn.env_vars ?? {});
    const runResult = await runEdgeFunction(fn.code, request, envVars, fn.timeout_ms);

    // Persist log (fire-and-forget)
    void (db as any).insertInto('zv_edge_function_logs').values({
      function_id:   fn.id,
      status:        runResult.ok ? (runResult.response?.status ?? 200) : 500,
      duration_ms:   runResult.duration_ms,
      request_body:  JSON.stringify(body)?.slice(0, 4000),
      response_body: runResult.ok ? JSON.stringify(runResult.response?.body)?.slice(0, 4000) : null,
      error:         runResult.error?.slice(0, 1000) ?? null,
    }).execute().catch(console.error);

    return c.json({
      result: {
        ok:          runResult.ok,
        status:      runResult.ok ? (runResult.response?.status ?? 200) : 500,
        body:        runResult.ok ? runResult.response?.body : null,
        logs:        runResult.logs,
        error:       runResult.error ?? null,
        duration_ms: runResult.duration_ms,
      },
    });
  });

  return app;
}

// Public invocation endpoint — mounted at /api/fn
// Supports session auth OR X-API-Key header
export function edgeFunctionInvokeRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.all('/:name', async (c) => {
    const name = c.req.param('name');

    // Auth: accept session or API key
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    let authed = !!session;
    if (!authed) {
      const rawKey = c.req.header('X-API-Key');
      if (rawKey) {
        const { hashApiKey } = await import('../lib/api-key-hash.js');
        const keyHash = await hashApiKey(rawKey);
        const apiKey = await (db as any)
          .selectFrom('zv_api_keys').select(['id', 'is_active', 'expires_at'])
          .where('key_hash', '=', keyHash).where('is_active', '=', true).executeTakeFirst().catch(() => null);
        authed = !!(apiKey && (!apiKey.expires_at || new Date(apiKey.expires_at) > new Date()));
      }
    }
    if (!authed) return c.json({ error: 'Unauthorized' }, 401);

    const fn = await (db as any)
      .selectFrom('zv_edge_functions').selectAll()
      .where('name', '=', name).where('is_active', '=', true).executeTakeFirst();
    if (!fn) return c.json({ error: 'Function not found' }, 404);

    if (fn.http_method !== 'ANY' && fn.http_method !== c.req.method) {
      return c.json({ error: `Method not allowed — expected ${fn.http_method}` }, 405);
    }

    // Parse request body
    let body: unknown = null;
    const ct = c.req.header('content-type') ?? '';
    try {
      if (ct.includes('application/json')) body = await c.req.json();
      else if (ct.includes('text/')) body = await c.req.text();
    } catch { /* ignore */ }

    const headersObj: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headersObj[k] = v; });

    const queryObj: Record<string, string> = {};
    new URL(c.req.url).searchParams.forEach((v, k) => { queryObj[k] = v; });

    const request: EdgeRequest = { method: c.req.method, headers: headersObj, query: queryObj, body, path: c.req.path };
    const envVars = typeof fn.env_vars === 'string' ? JSON.parse(fn.env_vars) : (fn.env_vars ?? {});
    const runResult = await runEdgeFunction(fn.code, request, envVars, fn.timeout_ms);

    void (db as any).insertInto('zv_edge_function_logs').values({
      function_id:   fn.id,
      status:        runResult.ok ? (runResult.response?.status ?? 200) : 500,
      duration_ms:   runResult.duration_ms,
      request_body:  JSON.stringify(body)?.slice(0, 4000),
      response_body: runResult.ok ? JSON.stringify(runResult.response?.body)?.slice(0, 4000) : null,
      error:         runResult.error?.slice(0, 1000) ?? null,
    }).execute().catch(console.error);

    if (!runResult.ok) return c.json({ error: runResult.error, logs: runResult.logs }, 500);

    const resp = runResult.response!;
    const honoRes = c.json(resp.body, resp.status as any);
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      honoRes.headers.set(k, v);
    }
    return honoRes;
  });

  return app;
}

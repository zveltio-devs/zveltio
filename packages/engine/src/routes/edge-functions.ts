import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { guardAdmin, guardSessionOrKey, type SessionSource } from '../lib/admin-guard.js';
import { auditLog } from '../lib/audit.js';
import { authenticate, EDGE_SCOPE, isApiKeyPrincipal } from '../lib/data/index.js';
import { runEdgeFunction, type EdgeRequest } from '../lib/edge-function-runner.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import { toJsonb } from '../lib/jsonb.js';
import { checkPermission, isTenantAdmin, keyIssuerAllows } from '../lib/tenancy/index.js';
import { rateLimit } from '../middleware/rate-limit.js';

/**
 * Rate limit for ANONYMOUS invocations of a public edge function.
 *
 * `ZVELTIO_PUBLIC=true` in a function's env vars makes it callable with no
 * session and no API key. That is a deliberate, opt-in feature — a webhook
 * receiver has to be reachable — but what it opts into is unauthenticated code
 * execution, and that had no ceiling at all: an anonymous caller could invoke
 * a function as fast as the process would answer.
 *
 * Its own bucket, not the shared auth one. A limiter shared across pre-auth
 * surfaces means an unrelated burst takes this down, and a public webhook
 * endpoint failing because someone else was probing SCIM is an outage with no
 * explanation in it.
 */
const publicEdgeInvokeRateLimit = rateLimit({
  keyPrefix: 'edge-public',
  max: 60,
  windowMs: 60_000,
  message: 'Too many anonymous invocations of this function.',
});

// Invocation endpoint — mounted at /api/fn. A session or an API key (X-API-Key or
// Authorization: Bearer) holding `execute` on `$edge`; anyone for a public function.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function edgeFunctionInvokeRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.all('/:name', async (c) => {
    const name = c.req.param('name');

    // Is this function deliberately public?
    //
    // Resolved BEFORE authentication, because the answer decides whether to
    // require any. The flag lives in the function's own `env_vars`, which is
    // where the extension put it — webhook receivers are the case it exists
    // for, and a Stripe or GitHub delivery carries no session and no API key.
    //
    // Tenant-filtered, like every other read of this table. `tenantId(c)` comes
    // from the host or the `x-tenant-slug` header, not from a session, so it is
    // available to an unauthenticated caller — which is the whole point here.
    //
    // Without the filter this probe answers about SOME function of that name.
    // Two tenants may each have a `webhook`; if one marked theirs public, an
    // unfiltered probe would report public and the tenant-filtered lookup below
    // would then run the OTHER tenant's function with no authentication at all.
    // The probe has to be scoped by the same key as the thing it authorises.
    const publicProbe = await reqDb(c, db)
      .selectFrom('zv_edge_functions')
      .select(['env_vars'])
      .where('name', '=', name)
      .where('is_active', '=', true)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst()
      // fabricated-ok: leaves `isPublic` false, so an unreadable function is treated as NOT public and still requires auth.
      .catch(() => null);
    const probeEnv = publicProbe?.env_vars;
    const parsedEnv = typeof probeEnv === 'string' ? JSON.parse(probeEnv) : (probeEnv ?? {});
    const isPublic = parsedEnv?.ZVELTIO_PUBLIC === 'true';

    // Who may run it. A private function needs `execute` on `$edge`: a session
    // from Casbin (tenant_member holds it by default, migration 094; god and
    // tenant admins through their total grants), a key from a `$edge` scope
    // naming `execute` or this function AND its issuer's Casbin grant. Signing in
    // used to be enough, so any member or any key of the tenant ran any function.
    //
    // A public function asks nobody for `$edge`, signed in or not: refusing a
    // member it serves anonymously would only make them drop the cookie.
    let authed: boolean;
    if (isPublic) {
      // fabricated-ok: an unreadable credential is treated as none, so the caller is rate-limited and audited as anonymous.
      authed = !!(await authenticate(c, auth, db).catch(() => null));
    } else {
      const user = await guardSessionOrKey(c, auth, db, EDGE_SCOPE, name);
      if (user instanceof Response) return user;
      const allowed = isApiKeyPrincipal(user)
        ? await keyIssuerAllows(user, EDGE_SCOPE, 'execute')
        : await checkPermission(user.id, EDGE_SCOPE, 'execute');
      if (!allowed) return c.json({ error: `Permission required: execute on ${EDGE_SCOPE}` }, 403);
      authed = true;
    }

    if (!authed) {
      // Anonymous, and therefore public. Applied here rather than as route
      // middleware because whether this request is anonymous is only known
      // after the session and API-key checks above have both come back empty.
      const limited = await publicEdgeInvokeRateLimit(c, async () => undefined);
      if (limited) return limited;

      // Recorded, because otherwise the only executions with no trace are the
      // ones nobody authenticated. `ZVELTIO_PUBLIC` on the function says it
      // COULD be called anonymously; this says it WAS.
      await auditLog(db, {
        type: 'edge_function.invoked_anonymously',
        resourceType: 'edge_function',
        metadata: { name, tenant_id: tenantId(c) },
      }).catch((err: Error) => {
        console.warn('[edge-functions] audit write failed on public invoke:', err.message);
      });
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const fn = await (reqDb(c, db) as any)
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('name', '=', name)
      .where('is_active', '=', true)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
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
    } catch {
      /* ignore */
    }

    // Headers the function must not see.
    //
    // Every header was forwarded verbatim into the sandbox, `cookie` included —
    // so an edge function received the session cookie of every caller and could
    // replay it against the API as them. The sandbox exists to contain the
    // function's code; handing it the caller's credentials on the way in
    // defeats the point of having one.
    //
    // Webhook signatures deliberately survive: `stripe-signature`,
    // `x-hub-signature-256` and friends are what a webhook receiver is FOR, and
    // they authenticate the sender rather than the caller.
    const CREDENTIAL_HEADERS = new Set([
      'cookie',
      'authorization',
      'x-api-key',
      'x-preview-token',
      'x-tenant-slug',
    ]);
    const headersObj: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) headersObj[k] = v;
    });

    const queryObj: Record<string, string> = {};
    new URL(c.req.url).searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });

    const request: EdgeRequest = {
      method: c.req.method,
      headers: headersObj,
      query: queryObj,
      body,
      path: c.req.path,
    };
    const envVars = typeof fn.env_vars === 'string' ? JSON.parse(fn.env_vars) : (fn.env_vars ?? {});
    const runResult = await runEdgeFunction(fn.code, request, envVars, fn.timeout_ms, fn.egress);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    void (reqDb(c, db) as any)
      .insertInto('zv_edge_function_logs')
      .values({
        tenant_id: tenantId(c),
        function_id: fn.id,
        status: runResult.ok ? (runResult.response?.status ?? 200) : 500,
        duration_ms: runResult.duration_ms,
        request_body: JSON.stringify(body)?.slice(0, 4000),
        response_body: runResult.ok
          ? JSON.stringify(runResult.response?.body)?.slice(0, 4000)
          : null,
        error: runResult.error?.slice(0, 1000) ?? null,
      })
      .execute()
      .catch(console.error);

    if (!runResult.ok) return c.json({ error: runResult.error, logs: runResult.logs }, 500);

    const resp = runResult.response!;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const honoRes = c.json(resp.body, resp.status as any);
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      honoRes.headers.set(k, v);
    }
    return honoRes;
  });

  return app;
}

/**
 * A host the function may reach: `host` or `host:port`, lower case, no scheme,
 * path or wildcard. The runner compares hostnames as the URL parser writes
 * them, so an entry the parser spells differently (an IPv4 shorthand, a
 * trailing dot) is refused here rather than silently never matching.
 */
const EGRESS_HOST =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;

function urlSpelling(entry: string): string | null {
  try {
    return new URL(`http://${entry}`).hostname;
  } catch {
    return null;
  }
}

/** `null` = undeclared (engine network); `[]` = no network; hosts = only those. */
const egressSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .refine((h) => EGRESS_HOST.test(h), {
        abort: true,
        error: (issue) =>
          `"${String(issue.input)}" is not a host — write host or host:port, no scheme, path or wildcard`,
      })
      .refine((h) => urlSpelling(h) === h.replace(/:\d{1,5}$/, ''), {
        error: (issue) => {
          const h = String(issue.input).trim().toLowerCase();
          const spelled = urlSpelling(h);
          return spelled
            ? `"${h}" is written "${spelled}" by the URL parser — list it that way`
            : `"${h}" is not a valid host:port`;
        },
      }),
  )
  .max(64)
  .transform((hosts) => [...new Set(hosts)])
  .nullable();

const envVarsSchema = z
  .record(z.string(), z.string())
  .refine((env) => !Object.hasOwn(env, 'ZVELTIO_EGRESS'), {
    error: 'ZVELTIO_EGRESS is no longer read — list the hosts in `egress`',
  });

const httpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']);

const CreateSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1),
  display_name: z.string().min(1).optional(),
  description: z.string().optional(),
  code: z.string().default(''),
  http_method: httpMethod.default('POST'),
  timeout_ms: z.number().int().min(100).max(300000).default(30000),
  env_vars: envVarsSchema.default({}),
  egress: egressSchema.default(null),
});

const UpdateSchema = z.object({
  display_name: z.string().min(1).optional(),
  description: z.string().optional(),
  code: z.string().optional(),
  http_method: httpMethod.optional(),
  is_active: z.boolean().optional(),
  timeout_ms: z.number().int().min(100).max(300000).optional(),
  env_vars: envVarsSchema.optional(),
  egress: egressSchema.optional(),
});

const idParam = zValidator('param', z.object({ id: z.string().uuid() }));

const sameHosts = (a: string[] | null, b: string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((h, i) => h === b[i]));

const DEFAULT_CODE = `// Edge function — runs inside the Zveltio engine

export default async function handler(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  return Response.json({ message: "Hello from edge!", input: body });
}
`;

const envOf = (v: unknown): Record<string, string> =>
  (typeof v === 'string' ? JSON.parse(v) : (v ?? {})) as Record<string, string>;

/**
 * Edge function administration, `/api/edge-functions`: list, read, create,
 * update, delete, recent invocation logs, and a test run. Tenant admins only
 * (`admin` on `*`), every row the running tenant's. A function is served at
 * `/api/fn/:name` by {@link edgeFunctionInvokeRoutes}.
 *
 * Who changed what a function may reach, or deleted it, is written to the audit
 * log: saving `egress` is the approval of that network access.
 */
export function edgeFunctionAdminRoutes(
  db: Database,
  auth: SessionSource,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.use('*', async (c, next) => {
    const user = await guardAdmin(c, auth, isTenantAdmin);
    if (user instanceof Response) return user;
    c.set('userId', user.id);
    await next();
  });

  const audit = (
    type: 'edge_function.egress_changed' | 'edge_function.deleted',
    userId: string,
    fn: { id: string; name: string },
    metadata: Record<string, unknown>,
  ) =>
    auditLog(db, {
      type,
      userId,
      resourceType: 'edge_function',
      resourceId: fn.id,
      metadata: { name: fn.name, ...metadata },
    }).catch((err: Error) => {
      console.warn(`[edge-functions] ${type} audit write failed:`, err.message);
    });

  app.get('/', async (c) => {
    const functions = await reqDb(c, db)
      .selectFrom('zv_edge_functions')
      .select([
        'id',
        'name',
        'display_name',
        'description',
        'http_method',
        'path',
        'is_active',
        'runtime',
        'egress',
        'created_at',
      ])
      .where('tenant_id', '=', tenantId(c))
      .orderBy('name', 'asc')
      .execute();
    return c.json({ functions });
  });

  app.get('/:id', idParam, async (c) => {
    const fn = await reqDb(c, db)
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('id', '=', c.req.valid('param').id)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
    if (!fn) return c.json({ error: 'Function not found' }, 404);
    return c.json({ function: fn });
  });

  app.post('/', zValidator('json', CreateSchema), async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    const fn = await reqDb(c, db)
      .insertInto('zv_edge_functions')
      .values({
        tenant_id: tenantId(c),
        name: body.name,
        display_name: body.display_name ?? body.name,
        description: body.description,
        code: body.code || DEFAULT_CODE,
        http_method: body.http_method,
        path: `/api/fn/${body.name}`,
        timeout_ms: body.timeout_ms,
        env_vars: toJsonb(body.env_vars),
        egress: body.egress,
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (body.egress !== null)
      await audit('edge_function.egress_changed', userId, fn, { before: null, after: body.egress });
    return c.json({ function: fn }, 201);
  });

  app.patch('/:id', idParam, zValidator('json', UpdateSchema), async (c) => {
    const body = c.req.valid('json');
    const { env_vars, ...rest } = body;
    const row = await reqDb(c, db)
      .updateTable('zv_edge_functions')
      .set({
        ...rest,
        ...(env_vars === undefined ? {} : { env_vars: toJsonb(env_vars) }),
        updated_at: new Date(),
      })
      .where('id', '=', c.req.valid('param').id)
      .where('tenant_id', '=', tenantId(c))
      .returningAll()
      .returning(sql<string[] | null>`old.egress`.as('egress_before'))
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Function not found' }, 404);
    const { egress_before: before, ...fn } = row;
    if (body.egress !== undefined && !sameHosts(before ?? null, body.egress)) {
      await audit('edge_function.egress_changed', c.get('userId'), fn, {
        before: before ?? null,
        after: body.egress,
      });
    }
    return c.json({ function: fn });
  });

  app.delete('/:id', idParam, async (c) => {
    const fn = await reqDb(c, db)
      .deleteFrom('zv_edge_functions')
      .where('id', '=', c.req.valid('param').id)
      .where('tenant_id', '=', tenantId(c))
      .returning(['id', 'name', 'path', 'egress'])
      .executeTakeFirst();
    if (!fn) return c.json({ error: 'Function not found' }, 404);
    await audit('edge_function.deleted', c.get('userId'), fn, { path: fn.path, egress: fn.egress });
    return c.json({ success: true });
  });

  app.get('/:id/logs', idParam, async (c) => {
    const logs = await reqDb(c, db)
      .selectFrom('zv_edge_function_logs')
      .select(['id', 'status', 'duration_ms', 'error', 'created_at'])
      .where('function_id', '=', c.req.valid('param').id)
      .where('tenant_id', '=', tenantId(c))
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return c.json({ logs });
  });

  /** A test run from the Studio: the function as saved, with the posted body. */
  app.post('/:id/invoke', idParam, async (c) => {
    const fn = await reqDb(c, db)
      .selectFrom('zv_edge_functions')
      .selectAll()
      .where('id', '=', c.req.valid('param').id)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
    if (!fn) return c.json({ error: 'Function not found' }, 404);

    const bodyText = await c.req.text();
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    const result = await runEdgeFunction(
      fn.code,
      {
        method: fn.http_method === 'ANY' ? 'POST' : fn.http_method,
        headers: { 'content-type': 'application/json' },
        query: Object.fromEntries(new URL(c.req.url).searchParams),
        body,
        path: fn.path,
      },
      envOf(fn.env_vars),
      fn.timeout_ms,
      fn.egress ?? null,
    );

    await reqDb(c, db)
      .insertInto('zv_edge_function_logs')
      .values({
        tenant_id: tenantId(c),
        function_id: fn.id,
        status: result.ok ? (result.response?.status ?? 200) : 500,
        duration_ms: result.duration_ms,
        request_body: bodyText.slice(0, 4000),
        response_body: result.ok ? JSON.stringify(result.response?.body)?.slice(0, 4000) : null,
        error: result.error?.slice(0, 1000) ?? null,
      })
      .execute()
      .catch((err: Error) => {
        console.warn('[edge-functions] invocation log failed:', err.message);
      });

    return c.json({ result });
  });

  return app;
}

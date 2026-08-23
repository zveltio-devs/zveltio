import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { auditLog } from '../lib/audit.js';
import { runEdgeFunction, type EdgeRequest } from '../lib/edge-function-runner.js';
import { reqDb, tenantId } from '../lib/route-db.js';
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

// Public invocation endpoint — mounted at /api/fn
// Supports session auth OR X-API-Key header
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

    // Auth: accept session or API key
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    let authed = !!session;
    if (!authed) {
      const rawKey = c.req.header('X-API-Key');
      if (rawKey) {
        // Shared with the data API rather than re-implemented. The local copy
        // checked the hash, `is_active` and expiry but not `tenant_id`, and
        // `zv_api_keys` is route-scoped rather than RLS-protected (the guard
        // has to run before a tenant is known), so `reqDb` filtered nothing:
        // tenant A's key authenticated here and the lookup below then served
        // tenant B's function.
        const { validateApiKey } = await import('../lib/data/index.js');
        const apiKey = await validateApiKey(db, rawKey, tenantId(c)).catch(() => null);
        authed = !!apiKey;
      }
    }
    if (!authed && !isPublic) return c.json({ error: 'Unauthorized' }, 401);

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

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    const runResult = await runEdgeFunction(fn.code, request, envVars, fn.timeout_ms);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const honoRes = c.json(resp.body, resp.status as any);
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      honoRes.headers.set(k, v);
    }
    return honoRes;
  });

  return app;
}

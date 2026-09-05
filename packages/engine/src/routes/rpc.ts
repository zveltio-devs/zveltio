/**
 * POST /api/rpc/:function — Call a whitelisted PostgreSQL function.
 *
 * Only functions registered in zvd_rpc_functions are callable.
 * Arguments are passed as a JSON body and forwarded as named parameters
 * to the function via SELECT * FROM function_name(param := value).
 *
 * Equivalent to Supabase's supabase.rpc('function', { args }).
 */

import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { reqDb } from '../lib/route-db.js';
import { checkPermission, requireInstanceAdmin } from '../lib/tenancy/index.js';
import { getUserRoles, resolveUserRole } from '../lib/tenancy/index.js';

const ROLE_RANK: Record<string, number> = {
  god: 100,
  admin: 80,
  member: 20,
};

function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 10;
}

async function userHasRole(
  userId: string,
  requiredRole: string,
  userRole: string,
): Promise<boolean> {
  if (userRole === 'god') return true;
  if (requiredRole === '*') return true;
  if (roleRank(userRole) >= roleRank(requiredRole)) return true;
  // Check Casbin roles
  const roles = await getUserRoles(userId);
  return roles.some((r) => roleRank(r) >= roleRank(requiredRole));
}

// Identifier: only letters, digits, underscores — no schema prefix injection
const FUNC_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function rpcRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // POST /api/rpc/:function
  app.post('/:fn', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const fnName = c.req.param('fn');
    if (!FUNC_NAME_RE.test(fnName)) {
      return c.json({ error: 'Invalid function name' }, 400);
    }

    // Lookup whitelist
    const entry = await sql<{
      function_name: string;
      required_role: string;
      is_enabled: boolean;
    }>`
      SELECT function_name, required_role, is_enabled
      FROM zvd_rpc_functions
      WHERE function_name = ${fnName}
      LIMIT 1
    `.execute(db);

    const fn = entry.rows[0];
    if (!fn || !fn.is_enabled) {
      return c.json({ error: 'Function not found' }, 404);
    }

    // Check role
    const user = session.user;
    // The real role, not `user.role ?? 'member'` — `session.user.role` is
    // always undefined (not declared in better-auth's additionalFields), so
    // every caller was ranked as `member` and the `god` short-circuit below
    // never fired. The Casbin fallback covered it, but ranking a god as a
    // member is the wrong input to a rank comparison.
    const hasAccess = await userHasRole(user.id, fn.required_role, await resolveUserRole(user));
    if (!hasAccess) return c.json({ error: 'Forbidden' }, 403);

    // Parse args — optional JSON body
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    let args: Record<string, any> = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw;
    } catch {
      /* no body or non-JSON — call with no args */
    }

    // Build parameterized call: SELECT * FROM fn(arg1 := $1, arg2 := $2)
    // Using named-parameter syntax prevents positional mismatch.
    //
    // Interpolate the name the WHITELIST returned, never the request's — the
    // two are equal today only because the lookup above is exact equality, so
    // using the request value would silently become injection the moment
    // anything could write a quote-bearing name into zvd_rpc_functions.
    const safeFnName = `"${fn.function_name.replace(/"/g, '""')}"`;
    try {
      const keys = Object.keys(args);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      let result: any;

      // The caller's tenant transaction, not the global pool.
      //
      // An RPC function is operator-authored SQL running with the engine's
      // rights. Executed on the raw pool it carried no tenant context, so a
      // function that reads a collection returned rows without regard to who
      // asked. On `reqDb(c)` the isolation policies apply to it like any other
      // query.
      const rdb = reqDb(c, db);

      if (keys.length === 0) {
        result = await sql`SELECT * FROM ${sql.raw(safeFnName)}()`.execute(rdb);
      } else {
        // Build named params: fn(key1 := val1, key2 := val2)
        const paramParts = keys.map(
          (k, _i) => sql`${sql.raw(`"${k.replace(/[^a-zA-Z0-9_]/g, '')}" :=`)} ${args[k]}`,
        );
        result = await sql`
          SELECT * FROM ${sql.raw(safeFnName)}(${sql.join(paramParts, sql`, `)})
        `.execute(rdb);
      }

      return c.json({ data: result.rows });
    } catch (err) {
      // The database's own words do not go back to the caller.
      //
      // Measured: an RPC function that violated a unique constraint answered
      // `duplicate key value violates unique constraint
      // "zvd_rpc_secretish_email_key"` — the table, the constraint and thus the
      // column, handed to whoever may call the function. `required_role` on the
      // whitelist can be `member`, so that is not necessarily an administrator.
      //
      // The caller gets the generic sentence and the trace id the envelope
      // already carries; the message and its SQLSTATE go to the log, where an
      // operator can match them by that id.
      //
      // A first version returned the SQLSTATE in the body as well, on the
      // argument that `42883 undefined function` tells a developer the class of
      // failure without naming a database object. Measured, it never arrived:
      // `ProblemDetails` is a fixed SDK contract and the normaliser drops fields
      // outside it. The comment claiming otherwise would have outlived the
      // behaviour by exactly as long as nobody checked.
      //
      // SQLSTATE arrives on `errno`, not `code`, on this driver.
      const sqlState = (err as { errno?: string; code?: string })?.errno;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[rpc] ${fn.function_name} failed${sqlState ? ` (${sqlState})` : ''}:`, message);
      return c.json({ error: 'Function execution failed' }, 500);
    }
  });

  // ── Admin: manage whitelist ────────────────────────────────────────

  app.get('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) return c.json({ error: 'Forbidden' }, 403);

    const rows = await sql`
      SELECT id, function_name, description, required_role, is_enabled, created_at
      FROM zvd_rpc_functions ORDER BY function_name
    `.execute(db);
    return c.json({ functions: rows.rows });
  });

  app.post('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body?.function_name || !FUNC_NAME_RE.test(body.function_name)) {
      return c.json({ error: 'Valid function_name required' }, 400);
    }

    const rows = await sql`
      INSERT INTO zvd_rpc_functions (function_name, description, required_role, is_enabled)
      VALUES (${body.function_name}, ${body.description ?? null}, ${body.required_role ?? 'member'}, ${body.is_enabled ?? true})
      RETURNING *
    `.execute(db);
    return c.json({ function: rows.rows[0] }, 201);
  });

  app.patch('/:id', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Body required' }, 400);

    const rows = await sql`
      UPDATE zvd_rpc_functions
      SET
        description  = COALESCE(${body.description ?? null}, description),
        required_role = COALESCE(${body.required_role ?? null}, required_role),
        is_enabled   = COALESCE(${body.is_enabled ?? null}, is_enabled)
      WHERE id = ${c.req.param('id')}
      RETURNING *
    `.execute(db);
    if (!rows.rows[0]) return c.json({ error: 'Not found' }, 404);
    return c.json({ function: rows.rows[0] });
  });

  app.delete('/:id', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) return c.json({ error: 'Forbidden' }, 403);

    await sql`DELETE FROM zvd_rpc_functions WHERE id = ${c.req.param('id')}`.execute(db);
    return c.json({ success: true });
  });

  return app;
}

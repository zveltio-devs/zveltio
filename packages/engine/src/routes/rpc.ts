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
import { checkPermission } from '../lib/permissions.js';
import { getUserRoles } from '../lib/permissions.js';

const ROLE_RANK: Record<string, number> = {
  god: 100, admin: 80, member: 20,
};

function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 10;
}

async function userHasRole(userId: string, requiredRole: string, userRole: string): Promise<boolean> {
  if (userRole === 'god') return true;
  if (requiredRole === '*') return true;
  if (roleRank(userRole) >= roleRank(requiredRole)) return true;
  // Check Casbin roles
  const roles = await getUserRoles(userId);
  return roles.some((r) => roleRank(r) >= roleRank(requiredRole));
}

// Identifier: only letters, digits, underscores — no schema prefix injection
const FUNC_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

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
    const hasAccess = await userHasRole(user.id, fn.required_role, user.role ?? 'member');
    if (!hasAccess) return c.json({ error: 'Forbidden' }, 403);

    // Parse args — optional JSON body
    let args: Record<string, any> = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw;
    } catch { /* no body or non-JSON — call with no args */ }

    // Build parameterized call: SELECT * FROM fn(arg1 := $1, arg2 := $2)
    // Using named-parameter syntax prevents positional mismatch.
    try {
      const keys = Object.keys(args);
      let result: any;

      if (keys.length === 0) {
        result = await sql`SELECT * FROM ${sql.raw(`"${fnName}"`)}()`.execute(db);
      } else {
        // Build named params: fn(key1 := val1, key2 := val2)
        const paramParts = keys.map((k, i) =>
          sql`${sql.raw(`"${k.replace(/[^a-zA-Z0-9_]/g, '')}" :=`)} ${args[k]}`,
        );
        result = await sql`
          SELECT * FROM ${sql.raw(`"${fnName}"`)}(${sql.join(paramParts, sql`, `)})
        `.execute(db);
      }

      return c.json({ data: result.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Function execution failed';
      return c.json({ error: msg }, 500);
    }
  });

  // ── Admin: manage whitelist ────────────────────────────────────────

  app.get('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) return c.json({ error: 'Forbidden' }, 403);

    const rows = await sql`
      SELECT id, function_name, description, required_role, is_enabled, created_at
      FROM zvd_rpc_functions ORDER BY function_name
    `.execute(db);
    return c.json({ functions: rows.rows });
  });

  app.post('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) return c.json({ error: 'Forbidden' }, 403);

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

  app.delete('/:id', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) return c.json({ error: 'Forbidden' }, 403);

    await sql`DELETE FROM zvd_rpc_functions WHERE id = ${c.req.param('id')}`.execute(db);
    return c.json({ success: true });
  });

  return app;
}

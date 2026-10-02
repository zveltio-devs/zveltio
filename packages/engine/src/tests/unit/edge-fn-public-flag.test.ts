/**
 * An edge function marked public in one tenant is not public in another.
 *
 * `ZVELTIO_PUBLIC=true` lets a function be invoked with no session or key. The
 * probe that reads it must be scoped to the requesting tenant: two tenants may
 * each have a function called `webhook`, and only one of them opted in.
 *
 * This file used to assert a local copy of the lookup (an array `find` with and
 * without the tenant), so the route could drop its tenant filter and nothing
 * here would notice. It drives the real handler now.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { edgeFunctionInvokeRoutes } from '../../routes/edge-functions.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Status of an anonymous call to `webhook` from `tenant`. */
async function anonymousCall(tenant: string): Promise<number> {
  const db = new CannedDb();
  // `webhook` exists in both tenants; only tenant A marked it public.
  db.when(/select "env_vars" from "zv_edge_functions"/i, (q) =>
    q.parameters.includes(TENANT_A)
      ? [{ env_vars: JSON.stringify({ ZVELTIO_PUBLIC: 'true' }) }]
      : // An explicit 'false' — only the exact string 'true' opts in.
        [{ env_vars: JSON.stringify({ ZVELTIO_PUBLIC: 'false' }) }],
  );
  // Past the gate the function lookup finds nothing, so a 404 means "let in".
  db.when(/select \* from "zv_edge_functions"/i, []);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenant' as never, { id: tenant } as never);
    await next();
  });
  app.route(
    '/',
    edgeFunctionInvokeRoutes(db.kysely as unknown as Database, {
      api: { getSession: async () => null },
    }),
  );
  return (await app.request('/webhook', { method: 'POST' })).status;
}

describe('edge function public flag', () => {
  it('lets an anonymous call through in the tenant that marked the function public', async () => {
    expect(await anonymousCall(TENANT_A)).toBe(404);
  });

  it('refuses it in a tenant whose function of the same name is not public', async () => {
    expect(await anonymousCall(TENANT_B)).toBe(401);
  });
});

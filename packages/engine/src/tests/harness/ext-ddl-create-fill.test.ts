/**
 * An extension creates a collection through `ctx.DDLManager` and fills it
 * through `ctx.db` in the same request — ai-alchemist's /execute — and both
 * succeed, with tenant RLS on or unavailable.
 *
 * Measured before the fix, in the request's tenant transaction: with
 * `zveltio_rls` the create failed 42501 (the request role may not CREATE on the
 * schema); without it, as the engine's superuser, 25001 (CREATE INDEX
 * CONCURRENTLY in a transaction block). And `ctx.DDLManager` was the bare
 * `DDLManager` the engine boots with, so even a create that ran left the table
 * without its policy and without the `zveltio_ext` grant the fill needs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  extensionDbRoleNames,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { buildExtensionInternals, type ExtensionContext } from '../../lib/extensions/internals.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { _setRlsRoleAvailableForTests } from '../../lib/tenancy/tenant-manager.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'createfill';
const TAG = Date.now();
// The flow reader holds SELECT on a collection; the others DML.
const NARROW = ['zveltio_ext', 'zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader'];
const NEEDS = ['INSERT', 'INSERT', 'INSERT', 'SELECT'];

d('an extension creates a collection and fills it in one request', () => {
  let db: Database;
  let ctx: ExtensionContext;
  const made: string[] = [];

  beforeAll(async () => {
    db = (await getTestApp()).db;
    _resetExtensionDbRoleForTests();
    // What `loadExtension` does once its migrations ran; the role is ready after.
    await grantExtensionDbRole(db, EXT, new Set());
    // The context the engine boots extensions with: the bare DDLManager included.
    ctx = buildRestrictedContext(
      { db, DDLManager } as unknown as ExtensionContext,
      EXT,
      new Hono(),
      new Set(),
      false,
    );
  });

  afterAll(async () => {
    // Roles are cluster-wide and outlive this database.
    await revokeExtensionDbRoles(db, EXT, true);
    _resetExtensionDbRoleForTests();
    for (const name of made) await dropTestCollection(db, name).catch(() => {});
  });

  // The request's transaction, with an actor, as the tenant middleware opens it.
  const withActor = <T>(fn: () => Promise<T>) =>
    withTenantIsolation(TENANT, fn, { identity: ALL_COLLECTIONS_ACTOR });

  for (const mode of ['enforced', 'unavailable'] as const) {
    it(`creates, grants and fills before commit (tenant RLS ${mode})`, async () => {
      const restore = _setRlsRoleAvailableForTests(mode === 'enforced');
      const name = `createfill_${mode}_${TAG}`;
      const table = `zvd_${name}`;
      made.push(name);
      try {
        // The tenant middleware's request transaction.
        await withActor(async () => {
          const ext = ctx.db as unknown as Database;
          // The extension's own role (a member of `zveltio_ext`, which holds collections).
          const role = await sql<{ r: string; d: string }>`
            SELECT current_user::text AS r, current_database() AS d`.execute(ext);
          expect(role.rows[0]!.r).toBe(extensionDbRoleNames(role.rows[0]!.d, EXT).role);
          await ctx.DDLManager.createCollection(ctx.db, {
            name,
            fields: [{ name: 'title', type: 'text', required: false }],
          } as never);
          // Isolated and granted to every narrow role before the request commits.
          const grants = await sql<{ role: string; ok: boolean }>`
            SELECT r AS role, has_table_privilege(r, ${`public.${table}`}, p) AS ok
              FROM unnest(${NARROW}::text[], ${NEEDS}::text[]) AS g(r, p)
             WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`.execute(db);
          expect(grants.rows.filter((g) => !g.ok).map((g) => g.role)).toEqual([]);
          await sql`INSERT INTO ${sql.id(table)} (title) VALUES ('filled')`.execute(ext);
        });
        const rows = await sql<{ title: string; tenant_id: string; forced: boolean }>`
          SELECT t.title, t.tenant_id::text AS tenant_id,
                 (SELECT relforcerowsecurity FROM pg_class WHERE oid = ${`public.${table}`}::regclass)
                   AS forced
            FROM ${sql.id(table)} t`.execute(db);
        expect(rows.rows).toEqual([{ title: 'filled', tenant_id: TENANT, forced: true }]);
      } finally {
        restore();
      }
    }, 60_000);
  }
});

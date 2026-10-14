/**
 * A `perTenant: true` schedule runs once per active firm where its extension is
 * active, each run inside that firm's transaction (B02).
 *
 * A schedule used to run once with no firm, so `ctx.db` fell through to the pool
 * with no tenant GUC. On this harness's role, which RLS binds, a FORCE-RLS table
 * answered for the root firm only: `communications/mail` polled the root firm's
 * mailboxes and no other, and the run was recorded `ok`. On a superuser pool it
 * read every firm's mailboxes and wrote their mail with the root firm's
 * `tenant_id`.
 *
 * The handler is called exactly as `CronRunnerImpl._runOne` calls it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { grantExtensionDbRole, revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { cronRunner } from '../../lib/runtime/index.js';
import type { ExtensionSchedule } from '../../lib/runtime/cron-runner.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const NAME = `pertenant${STAMP}`;
const TABLE = `zv_${NAME}_items`;
const ROOT = '00000000-0000-0000-0000-000000000001';
const ON = crypto.randomUUID();
const OFF = crypto.randomUUID();
const FAILS = crypto.randomUUID();
const SUSPENDED = crypto.randomUUID();
const OURS = [ROOT, ON, OFF, FAILS, SUSPENDED];

d('a perTenant schedule runs once per active firm, inside its transaction', () => {
  let db: Database;
  /** One entry per handler call: the tenant ids of the rows it could see. */
  let calls: string[][] = [];

  /** As the table owner, with the tenant GUC set — the policy then admits `t`. */
  const asTenant = <T>(t: string, fn: (trx: Database) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('zveltio.current_tenant', ${t}, true)`.execute(trx);
      return fn(trx as unknown as Database);
    });

  const fire = async () => {
    const entries = (
      cronRunner as unknown as { entries: Map<string, { schedule: ExtensionSchedule }> }
    ).entries;
    // The base context `index.ts` hands `cronRunner.start`.
    const base = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    return entries.get(`${NAME}::sync`)!.schedule.handler(base, crypto.randomUUID());
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    _setInlineForTests(true);
    await sql`
      CREATE TABLE ${sql.table(TABLE)} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL DEFAULT COALESCE(
          NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
          '00000000-0000-0000-0000-000000000001'::uuid),
        label text NOT NULL
      )`.execute(db);
    await sql`ALTER TABLE ${sql.table(TABLE)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.table(TABLE)} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY tenant_isolation ON ${sql.table(TABLE)}
      USING (zveltio_tenant_scope_ok(tenant_id)) WITH CHECK (zveltio_tenant_scope_ok(tenant_id))
    `.execute(db);
    for (const [id, status] of [
      [ON, 'active'],
      [OFF, 'active'],
      [FAILS, 'active'],
      [SUSPENDED, 'suspended'],
    ] as const) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}, ${`pt-${id.slice(0, 8)}`}, ${id}, ${status})`.execute(db);
    }
    for (const t of OURS) {
      await asTenant(t, (trx) =>
        sql`INSERT INTO ${sql.table(TABLE)} (label) VALUES ('seed')`.execute(trx),
      );
    }
    // On for every firm, switched off by one firm's own row.
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${NAME}, ${NAME}, NULL, true, true), (${NAME}, ${NAME}, ${OFF}, true, false)
    `.execute(db);

    const allowed = new Set([TABLE]);
    await grantExtensionDbRole(db, NAME, allowed);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    const ext: ZveltioExtension = {
      name: NAME,
      category: 'custom',
      mountStrategy: 'subapp',
      async register() {},
      schedules: () => [
        {
          name: 'sync',
          intervalMs: 3_600_000,
          perTenant: true,
          async handler(sctx) {
            const c = sctx as unknown as ExtensionContext;
            const rows = await sql<{ t: string }>`
              SELECT DISTINCT tenant_id::text AS t FROM ${sql.table(TABLE)}`.execute(c.db);
            const seen = rows.rows.map((r) => r.t).sort();
            calls.push(seen);
            await sql`INSERT INTO ${sql.table(TABLE)} (label) VALUES ('ran')`.execute(c.db);
            if (seen.includes(FAILS)) throw new Error('mailbox unreachable');
          },
        },
      ],
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      NAME,
      `/tmp/${NAME}`,
      new Hono(),
      ctx,
      { name: NAME, version: '1.0.0', category: 'custom', permissions: [] } as never,
      allowed,
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    _setInlineForTests(false);
    cronRunner.unregisterAll(NAME);
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await revokeExtensionDbRoles(db, NAME, true);
    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ANY(${[ON, OFF, FAILS, SUSPENDED]}::uuid[])`.execute(
      db,
    );
  });

  it('runs once per active firm with the extension on, each seeing only its own rows', async () => {
    calls = [];
    let thrown: Error | null = null;
    await fire().catch((err: Error) => {
      thrown = err;
    });

    // Other firms on the shared harness database see none of this table's rows.
    const ours = calls.filter((seen) => seen.length > 0).map((seen) => seen.join(','));
    expect(ours.sort()).toEqual([ROOT, ON, FAILS].sort());
    // One firm's failure did not stop the others; the run still fails, naming it.
    expect((thrown as Error | null)?.message).toContain(FAILS);
  });

  it("writes land in the firm that ran, and a failed firm's writes roll back", async () => {
    const ran: Record<string, number> = {};
    for (const t of OURS) {
      ran[t] = await asTenant(t, async (trx) => {
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ${sql.table(TABLE)}
           WHERE label = 'ran' AND tenant_id = ${t}::uuid`.execute(trx);
        return r.rows[0]!.n;
      });
    }
    expect(ran).toEqual({ [ROOT]: 1, [ON]: 1, [OFF]: 0, [FAILS]: 0, [SUSPENDED]: 0 });
  });
});

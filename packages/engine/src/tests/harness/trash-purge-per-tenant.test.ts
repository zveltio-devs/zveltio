/**
 * The trash purge ran once, on the raw engine handle, with no tenant GUC. The
 * handler (`storage/cloud`) deletes from `zv_media_files` with no tenant
 * predicate of its own — it relies on RLS — so with no GUC it saw the DEFAULT
 * tenant and purged nothing for every other company on the instance. No error,
 * no log: deleting nothing looks exactly like having nothing to delete.
 *
 * `runPerTenant` existed for this, documented the defect in its own comment,
 * and was called from nowhere. Dead code protecting nothing.
 *
 * This asserts the observable property: one invocation per active tenant, each
 * one seeing its own `zveltio.current_tenant`.
 */
import { afterEach, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { extensionRegistry } from '../../lib/extensions/index.js';
import { _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

afterEach(() => {
  extensionRegistry.registerTrashPurgeHandler(async () => {});
});

it.skipIf(!harnessAvailable())(
  'the trash purge runs once per active tenant, inside that tenant',
  async () => {
    const { db } = await getTestApp();
    const extra = crypto.randomUUID();
    await sql`
      INSERT INTO zv_tenants (id, name, slug, status)
      VALUES (${extra}, 'purge probe tenant', ${`purge-probe-${extra.slice(0, 8)}`}, 'active')
    `.execute(db);

    const seen: string[] = [];
    extensionRegistry.registerTrashPurgeHandler(async (tenantDb: Database) => {
      const r = await sql<{ t: string | null }>`
        SELECT current_setting('zveltio.current_tenant', true) AS t
      `.execute(tenantDb);
      seen.push(r.rows[0]?.t ?? '');
    });

    try {
      const active = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_tenants WHERE status = 'active'
      `.execute(db);
      await _internalForTests.runTrashPurge(db);

      // One call per active tenant — not one call in total.
      expect(seen.length).toBe(active.rows[0]!.n);
      // And each call carried a tenant, rather than falling back to the default
      // because the GUC was absent.
      expect(seen).toContain(extra);
      expect(seen.every((t) => t !== '')).toBe(true);
    } finally {
      await sql`DELETE FROM zv_tenants WHERE id = ${extra}`.execute(db);
    }
  },
  30_000,
);

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
    // An archived tenant (DELETE /api/tenants/:id sets 'deleted') keeps its
    // data by definition; a purge that reached it would empty a trash the
    // archive promised to keep.
    const archived = crypto.randomUUID();
    await sql`
      INSERT INTO zv_tenants (id, name, slug, status)
      VALUES (${archived}, 'archived probe', ${`purge-arch-${archived.slice(0, 8)}`}, 'deleted')
    `.execute(db);

    const seen: string[] = [];
    extensionRegistry.registerTrashPurgeHandler(async (tenantDb: Database) => {
      const r = await sql<{ t: string | null }>`
        SELECT current_setting('zveltio.current_tenant', true) AS t
      `.execute(tenantDb);
      const t = r.rows[0]?.t ?? '';
      seen.push(t);
      // Fail first in line, on purpose: a throw here must cost this tenant its
      // purge, not every tenant scheduled after it.
      if (t === first) throw new Error('purge probe failure');
    });
    const first = (
      await sql<{ id: string }>`
        SELECT id::text AS id FROM zv_tenants WHERE status = 'active' ORDER BY created_at LIMIT 1
      `.execute(db)
    ).rows[0]!.id;

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
      expect(seen).not.toContain(archived);
    } finally {
      await sql`DELETE FROM zv_tenants WHERE id IN (${extra}, ${archived})`.execute(db);
    }
  },
  30_000,
);

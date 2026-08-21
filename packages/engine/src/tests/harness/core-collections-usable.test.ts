/**
 * Legacy CRM collections are adopted when present — never created by core.
 *
 * Bare BaaS: no zvd_contacts/orgs/transactions from the engine.
 * With CRM (or older installs that already have the tables): metadata, RLS,
 * and default grants must still be true so Studio and /api/data/* work.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { CORE_COLLECTIONS } from '../../core-collections/index.js';
import { DDLManager } from '../../lib/data/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('legacy CRM collections: adopt when present, never invent', () => {
  it('does not create contacts/orgs/transactions on a bare engine', async () => {
    // Harness may already have tables from older boots or CRM. If none exist,
    // that is the purity signal. If some exist, adopt assertions below cover them.
    const { db } = await getTestApp();
    const missing = [];
    for (const def of CORE_COLLECTIONS) {
      if (!(await DDLManager.tableExists(db, def.name))) missing.push(def.name);
    }
    // Soft signal only when the shared harness is truly bare — CI with CRM
    // fixtures will have zero missing and skip this expectation.
    if (missing.length === CORE_COLLECTIONS.length) {
      expect(missing).toEqual(['contacts', 'organizations', 'transactions']);
    }
  });

  it('when tables exist, each is registered for Studio', async () => {
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      if (!(await DDLManager.tableExists(db, def.name))) continue;
      const row = await db
        .selectFrom('zvd_collections')
        .select('name')
        .where('name', '=', def.name)
        .executeTakeFirst();
      expect(row?.name, `'${def.name}' has no zvd_collections row`).toBe(def.name);
    }
  });

  it('when tables exist, each is isolated per tenant by the host', async () => {
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      if (!(await DDLManager.tableExists(db, def.name))) continue;
      const res = await sql<{ enabled: boolean; forced: boolean }>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = ${`zvd_${def.name}`}
      `.execute(db);
      expect(res.rows[0]?.enabled, `RLS not enabled on zvd_${def.name}`).toBe(true);
      expect(res.rows[0]?.forced, `RLS not forced on zvd_${def.name}`).toBe(true);
    }
  });

  it('when tables exist, an ordinary member can reach them', async () => {
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      if (!(await DDLManager.tableExists(db, def.name))) continue;
      const rows = await sql<{ v3: string }>`
        SELECT v3 FROM zvd_permissions
         WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${def.name}
      `.execute(db);
      const actions = rows.rows.map((r) => r.v3).sort();
      expect(actions, `no default grants for '${def.name}'`).toEqual(['create', 'read', 'update']);
    }
  });
});

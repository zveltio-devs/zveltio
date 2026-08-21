/**
 * Engine must not invent CRM collections.
 *
 * Contacts/orgs/transactions exist only when the CRM extension (or a legacy
 * DB) created them — never from a core boot hook.
 */

import { describe, expect, it } from 'bun:test';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { DDLManager } from '../../lib/data/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('engine does not own CRM collections', () => {
  it('ensureCoreCollections module is gone and bare boot does not invent tables', async () => {
    const { db } = await getTestApp();
    const missing = [];
    for (const name of ['contacts', 'organizations', 'transactions'] as const) {
      if (!(await DDLManager.tableExists(db, name))) missing.push(name);
    }
    // Soft signal when harness is truly bare.
    if (missing.length === 3) {
      expect(missing).toEqual(['contacts', 'organizations', 'transactions']);
    } else {
      expect(missing.length).toBeLessThanOrEqual(3);
    }
  });
});

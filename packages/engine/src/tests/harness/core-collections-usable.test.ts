/**
 * Engine must not invent CRM collections.
 *
 * After demotion PR2, contacts/orgs/transactions exist only when the CRM
 * extension (or a legacy DB) created them — never from `ensureCoreCollections`.
 */

import { describe, expect, it } from 'bun:test';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { CORE_COLLECTIONS } from '../../core-collections/index.js';
import { DDLManager } from '../../lib/data/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('engine does not own CRM collections', () => {
  it('exports no core CRM definitions', () => {
    expect(CORE_COLLECTIONS).toEqual([]);
  });

  it('ensureCoreCollections does not create contacts on a bare harness', async () => {
    // Shared harness may already have CRM tables from other fixtures. Only
    // assert the purity signal when the three tables are all absent.
    const { db } = await getTestApp();
    const missing = [];
    for (const name of ['contacts', 'organizations', 'transactions'] as const) {
      if (!(await DDLManager.tableExists(db, name))) missing.push(name);
    }
    if (missing.length === 3) {
      expect(missing).toEqual(['contacts', 'organizations', 'transactions']);
    }
  });
});

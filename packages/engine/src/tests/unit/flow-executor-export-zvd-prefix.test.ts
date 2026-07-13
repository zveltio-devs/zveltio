/**
 * flow-executor.ts — export_collection strips a zvd_ prefix from collection names.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const exportMock = mock(async () => ({
  buffer: new Uint8Array([1, 2, 3]),
  filename: 'export.csv',
}));

mock.module('../../lib/export-manager.js', () => ({
  ExportManager: { export: exportMock },
}));

const { _internalForTests } = await import('../../lib/flows/flow-executor.js');
const { executeStep } = _internalForTests;

describe('executeStep — export_collection zvd_ prefix', () => {
  it('queries zvd_contacts when config.collection is zvd_contacts', async () => {
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_contacts"/i, [{ id: 'c1', title: 'Row' }]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: { collection: 'zvd_contacts', format: 'csv' },
      },
      {},
      {},
    );

    expect(output.exported).toBe(true);
    expect(output.rows).toBe(1);
    expect(db.executed(/from "zvd_contacts"/i)).toHaveLength(1);
  });
});

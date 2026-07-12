/**
 * export_collection catch path when ExportManager is unavailable (flow-executor.ts).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

mock.module('../../lib/export-manager.js', () => ({
  ExportManager: {
    export: async () => {
      throw new Error('export service down');
    },
  },
}));

const { _internalForTests } = await import('../../lib/flows/flow-executor.js');
const { executeStep } = _internalForTests;

describe('executeStep — export_collection unavailable', () => {
  it('returns exported:false when ExportManager.export throws', async () => {
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_reports"/i, [{ id: '1', total: 9 }]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: { collection: 'reports', format: 'csv' },
      },
      {},
      {},
    );

    expect(output.exported).toBe(false);
    expect(output.error).toBe('Export service not configured');
  });
});

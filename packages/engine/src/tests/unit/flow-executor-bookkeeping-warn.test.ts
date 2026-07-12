/**
 * executeFlow — bookkeeping UPDATE failures are logged but non-fatal (flow-executor.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const RUN_INSERT = /INSERT INTO zv_flow_runs/i;
const STEPS_SELECT = /SELECT \* FROM zv_flow_steps/i;
const RUN_UPDATE = /UPDATE zv_flow_runs/i;

describe('executeFlow — bookkeeping update failures', () => {
  it('warns when marking a successful run fails but still returns success', async () => {
    const db = new CannedDb();
    db.when(RUN_INSERT, [{ id: 'run-ok' }]);
    db.when(STEPS_SELECT, [
      { id: 's1', name: 'noop', type: 'unknown_kind', step_order: 1, config: {} },
    ]);
    db.fail(RUN_UPDATE, new Error('update denied'));

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await executeFlow(db.kysely as unknown as Database, 'flow-ok', {});
      expect(result.status).toBe('success');
      expect(result.runId).toBe('run-ok');
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('failed to mark run run-ok as success')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when marking a failed run fails after a step error', async () => {
    const db = new CannedDb();
    db.when(RUN_INSERT, [{ id: 'run-fail' }]);
    db.when(STEPS_SELECT, [
      {
        id: 's1',
        name: 'bad',
        type: 'query_db',
        step_order: 1,
        config: { query: 'DROP TABLE users' },
      },
    ]);
    db.fail(RUN_UPDATE, new Error('update denied'));

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await executeFlow(db.kysely as unknown as Database, 'flow-fail', {});
      expect(result.status).toBe('failed');
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('failed to mark run run-fail as failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

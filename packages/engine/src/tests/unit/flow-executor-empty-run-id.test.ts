/**
 * executeFlow — empty RETURNING id after INSERT (flow-executor.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const RUN_INSERT = /INSERT INTO zv_flow_runs/i;

describe('executeFlow — empty run id', () => {
  it('returns failed when INSERT succeeds but RETURNING id is missing', async () => {
    const db = new CannedDb();
    db.when(RUN_INSERT, [{}]);
    const result = await executeFlow(db.kysely as unknown as Database, 'flow-empty-id', {});
    expect(result.status).toBe('failed');
    expect(result.runId).toBe('');
    expect(result.error).toMatch(/Failed to create run record/);
  });
});

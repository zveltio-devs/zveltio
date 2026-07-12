/**
 * send_notification — getUsersForRole swallows SQL errors (flow-executor.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

describe('executeStep — send_notification role lookup failures', () => {
  it('reports sent with count 0 when the permissions query throws', async () => {
    const db = new CannedDb();
    db.fail(/SELECT v0 FROM zvd_permissions/i, new Error('permissions table missing'));

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'send_notification',
        config: { role: 'editor', title: 'Hi', message: 'There' },
      },
      {},
      {},
    );

    expect(output.sent).toBe(true);
    expect(output.count).toBe(0);
    expect(db.executed(/INSERT INTO "zv_notifications"/i)).toHaveLength(0);
  });
});

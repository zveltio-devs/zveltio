/**
 * send_notification — a role lookup that fails fails the step (flow-executor.ts).
 *
 * `getUsersForRole` used to swallow the error and return `[]`, so the step
 * reported `{ sent: true, count: 0 }`: a notification nobody received, recorded
 * as a successful run. Thrown, it goes through the step's `on_error` like any
 * other step failure.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

describe('executeStep — send_notification role lookup failures', () => {
  it('throws when the permissions query throws, and notifies nobody', async () => {
    const db = new CannedDb();
    db.fail(/FROM zvd_permissions/i, new Error('permissions table missing'));

    await expect(
      executeStep(
        db.kysely as unknown as Database,
        {
          type: 'send_notification',
          config: { role: 'editor', title: 'Hi', message: 'There' },
        },
        {},
        {},
      ),
    ).rejects.toThrow('permissions table missing');
    expect(db.executed(/INSERT INTO "zv_notifications"/i)).toHaveLength(0);
  });
});

/**
 * flow-scheduler.ts — ai_task failure error log when the provider rejects.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler } from '../../lib/flows/flow-scheduler.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_UPDATE = /update "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

afterEach(() => {
  flowScheduler.stop();
  serviceRegistry.unregisterAs('test', 'ai.runBackgroundTask');
});

describe('flowScheduler._executeScheduledFlow — ai_task failure log', () => {
  it('logs when ai.runBackgroundTask rejects', async () => {
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => {
      throw new Error('model unavailable');
    });
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await injectDb(db);
      await flowScheduler._executeScheduledFlow({
        id: 'ai-fail',
        name: 'Digest',
        trigger_type: 'ai_task',
        trigger_config: { user_id: 'u1', instruction: 'go' },
        created_by: 'u1',
      });
      expect(
        errSpy.mock.calls.some((c) => {
          const meta = c[1] as { flow?: string; error?: string } | undefined;
          return String(c[0]).includes('ai_task failed') && meta?.flow === 'ai-fail';
        }),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

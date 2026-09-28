/**
 * flow-scheduler.ts — ai_task failure error log when the provider rejects.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler } from '../../lib/flows/flow-scheduler.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_UPDATE = /update "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  initTenantManager(db.kysely as unknown as Database);
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

afterEach(() => {
  flowScheduler.stop();
  serviceRegistry.unregisterAs('test', 'ai.runBackgroundTask');
  initTenantManager(null as unknown as Database);
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
        tenant_id: 'tenant-1',
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

  // The `ai` extension catches its own failure and RESOLVES `{ executed: false }`.
  // Reading only the rejection logged every such run as "completed".
  it('logs a task that reports it did not execute as failed, not completed', async () => {
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => ({
      executed: false,
      error: 'provider timed out',
    }));
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await injectDb(db);
      await flowScheduler._executeScheduledFlow({
        id: 'ai-not-executed',
        name: 'Digest',
        trigger_type: 'ai_task',
        tenant_id: 'tenant-1',
        trigger_config: { user_id: 'u1', instruction: 'go' },
        created_by: 'u1',
      });
      const failed = errSpy.mock.calls.find((c) => String(c[0]).includes('ai_task failed'));
      expect((failed?.[1] as { flow?: string; error?: string } | undefined)?.error).toBe(
        'provider timed out',
      );
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('ai_task completed'))).toBe(false);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

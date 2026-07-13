/**
 * flow-scheduler.ts — ai_task skip warning + success log lines.
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

describe('flowScheduler._executeScheduledFlow — ai_task telemetry', () => {
  it('warns when the AI extension is not registered', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    await injectDb(db);

    await flowScheduler._executeScheduledFlow({
      id: 'ai-skip',
      name: 'Digest',
      trigger_type: 'ai_task',
      trigger_config: { user_id: 'u1', instruction: 'go' },
      created_by: 'u1',
    });

    expect(
      warn.mock.calls.some(
        (c) =>
          String(c[0]).includes('ai_task skipped') &&
          String(c[0]).includes('AI extension is not active'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('logs when an ai_task run completes successfully', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => {});
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    await injectDb(db);

    await flowScheduler._executeScheduledFlow({
      id: 'ai-ok',
      name: 'Digest',
      trigger_type: 'ai_task',
      trigger_config: { user_id: 'u1', instruction: 'go' },
      created_by: 'u1',
    });

    expect(
      log.mock.calls.some((c) => {
        const meta = c[1] as { flow?: string } | undefined;
        return String(c[0]).includes('ai_task completed') && meta?.flow === 'ai-ok';
      }),
    ).toBe(true);
    log.mockRestore();
  });
});

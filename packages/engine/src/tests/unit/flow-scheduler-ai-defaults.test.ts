/**
 * flow-scheduler.ts — ai_task default instruction + option fallbacks.
 */

import { afterEach, describe, expect, it } from 'bun:test';
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

describe('flowScheduler._executeScheduledFlow — ai_task defaults', () => {
  it('falls back to created_by, description, and default notify options', async () => {
    const calls: unknown[][] = [];
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async (...args: unknown[]) => {
      calls.push(args);
    });
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    await injectDb(db);

    await flowScheduler._executeScheduledFlow({
      id: 'ai-defaults',
      name: 'Digest',
      trigger_type: 'ai_task',
      trigger_config: {},
      created_by: 'owner-1',
      description: 'Summarize open tickets',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('owner-1');
    expect(calls[0]![1]).toBe('Summarize open tickets');
    const opts = calls[0]![2] as {
      notifyOnResult: boolean;
      notifyOnlyIfData: boolean;
      notificationTitle: string;
      maxIterations: number;
    };
    expect(opts.notifyOnResult).toBe(true);
    expect(opts.notifyOnlyIfData).toBe(false);
    expect(opts.notificationTitle).toBe('Digest');
    expect(opts.maxIterations).toBe(5);
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });

  it('uses trigger_config overrides when present', async () => {
    const calls: unknown[][] = [];
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async (...args: unknown[]) => {
      calls.push(args);
    });
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    await injectDb(db);

    await flowScheduler._executeScheduledFlow({
      id: 'ai-overrides',
      name: 'Custom',
      trigger_type: 'ai_task',
      trigger_config: {
        user_id: 'u99',
        instruction: 'run audit',
        notify_on_result: false,
        notify_only_if_data: true,
        notification_title: 'Audit done',
        max_iterations: 2,
        interval_seconds: 1800,
      },
      created_by: 'ignored',
      description: 'ignored too',
    });

    expect(calls[0]![0]).toBe('u99');
    expect(calls[0]![1]).toBe('run audit');
    const opts = calls[0]![2] as {
      notifyOnResult: boolean;
      notifyOnlyIfData: boolean;
      notificationTitle: string;
      maxIterations: number;
    };
    expect(opts.notifyOnResult).toBe(false);
    expect(opts.notifyOnlyIfData).toBe(true);
    expect(opts.notificationTitle).toBe('Audit done');
    expect(opts.maxIterations).toBe(2);
  });
});

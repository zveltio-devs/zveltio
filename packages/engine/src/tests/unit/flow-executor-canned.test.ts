/**
 * executeFlow + executeStep coverage via CannedDb (no Postgres).
 *
 * Complements flow-executor-extra.test.ts (harness DB for collection steps) by
 * driving the run orchestration and lightweight step branches entirely in-memory.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { executeFlow, _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

const RUN_INSERT = /INSERT INTO zv_flow_runs/i;
const STEPS_SELECT = /SELECT \* FROM zv_flow_steps/i;
const RUN_UPDATE = /UPDATE zv_flow_runs/i;

function dbForFlow(
  steps: unknown[],
  runId = 'run-1',
): CannedDb {
  const db = new CannedDb();
  db.when(RUN_INSERT, [{ id: runId }]);
  db.when(STEPS_SELECT, steps);
  db.whenAffected(RUN_UPDATE, 1);
  return db;
}

describe('executeFlow (CannedDb)', () => {
  it('creates a run, executes unknown step types, and marks success', async () => {
    const db = dbForFlow([
      {
        id: 's1',
        name: 'noop',
        type: 'not_a_real_step',
        step_order: 1,
        config: {},
      },
    ]);

    const result = await executeFlow(db.kysely as unknown as Database, 'flow-1', {
      source: 'unit',
    });
    expect(result.status).toBe('success');
    expect(result.runId).toBe('run-1');
    expect(db.executed(RUN_UPDATE).length).toBeGreaterThanOrEqual(1);
  });

  it('continues after a failing step when on_error is continue', async () => {
    const db = dbForFlow(
      [
        {
          id: 's1',
          name: 'bad-query',
          type: 'query_db',
          step_order: 1,
          config: { query: 'DELETE FROM secrets' },
          on_error: 'continue',
        },
        {
          id: 's2',
          name: 'after',
          type: 'noop_step',
          step_order: 2,
          config: {},
        },
      ],
      'run-2',
    );

    const result = await executeFlow(db.kysely as unknown as Database, 'flow-2', {});
    expect(result.status).toBe('success');
    expect(String(result.output.error ?? '')).toMatch(/SELECT|read-only/i);
  });

  it('fails the run when a step throws and on_error is stop (default)', async () => {
    const db = dbForFlow(
      [
        {
          id: 's1',
          name: 'bad-query',
          type: 'query_db',
          step_order: 1,
          config: { query: 'DROP TABLE users' },
        },
      ],
      'run-3',
    );

    const result = await executeFlow(db.kysely as unknown as Database, 'flow-3', {});
    expect(result.status).toBe('failed');
    expect(result.runId).toBe('run-3');
    expect(result.error).toMatch(/SELECT|read-only|blocked/i);
  });

  it('returns failed when the run insert fails', async () => {
    const db = new CannedDb();
    db.fail(RUN_INSERT, new Error('insert denied'));
    const result = await executeFlow(db.kysely as unknown as Database, 'flow-x', {});
    expect(result.status).toBe('failed');
    expect(result.runId).toBe('');
    expect(result.error).toMatch(/insert denied/);
  });

  it('returns failed when loading steps fails after the run row exists', async () => {
    const db = new CannedDb();
    db.when(RUN_INSERT, [{ id: 'run-4' }]);
    db.fail(STEPS_SELECT, new Error('steps table missing'));
    db.whenAffected(RUN_UPDATE, 1);
    const result = await executeFlow(db.kysely as unknown as Database, 'flow-4', {});
    expect(result.status).toBe('failed');
    expect(result.runId).toBe('run-4');
    expect(result.error).toMatch(/steps table missing/);
  });
});

describe('executeStep — CannedDb branches', () => {
  it('send_notification fans out to every user in a Casbin role', async () => {
    const db = new CannedDb();
    db.when(/SELECT v0 FROM zvd_permissions/i, [{ v0: 'u-a' }, { v0: 'u-b' }]);
    db.when(/INSERT INTO "zv_notifications"/i, []);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'send_notification',
        config: { role: 'editor', title: 'Hi', message: 'From flow' },
      },
      {},
      {},
    );
    expect(output.sent).toBe(true);
    expect(output.count).toBe(2);
    expect(db.executed(/INSERT INTO "zv_notifications"/i).length).toBeGreaterThanOrEqual(1);
  });

  it('ai_decision leaves __proto__ placeholders literal in the prompt', async () => {
    const { output } = await executeStep(
      new CannedDb().kysely as unknown as Database,
      {
        type: 'ai_decision',
        config: {
          prompt: 'Pick {{trigger.choice}} not {{__proto__.polluted}}',
          options: ['yes', 'no'],
          fallback: 'no',
        },
      },
      {},
      { trigger: { choice: 'yes' } },
    );
    expect(output.usedFallback).toBe(true);
    expect(output.decision).toBe('no');
  });

  it('webhook forwards allowed custom headers and blocks sensitive ones', async () => {
    const originalFetch = globalThis.fetch;
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    try {
      await executeStep(
        new CannedDb().kysely as unknown as Database,
        {
          type: 'webhook',
          config: {
            url: 'https://example.com/hook',
            method: 'POST',
            headers: {
              Authorization: 'secret',
              'X-Custom': 'allowed',
              'x-api-key': 'blocked',
            },
            body: { ok: true },
          },
        },
        {},
        {},
      );
      expect(seenHeaders?.['X-Custom']).toBe('allowed');
      expect(seenHeaders?.Authorization).toBeUndefined();
      expect(seenHeaders?.['x-api-key']).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});

/**
 * `lib/data/write-pipeline.ts` imported `triggerDataFlows` from
 * `routes/flows.ts`, closing a cycle back into `lib/flows`. Loaded with
 * `lib/flows` first, `routes/flows.ts` evaluated `z.enum(EXECUTABLE_STEP_TYPES)`
 * before `flow-executor.ts` had defined it, and threw. The engine's own entry
 * point loads routes first and never saw it; a single `bun test` process over
 * the unit folder did, as 296 failures. A fresh process is the only way to pin
 * the load order.
 */
import { describe, expect, it } from 'bun:test';

describe('lib/flows import order', () => {
  it('loads with flow-executor as the first module', () => {
    const run = Bun.spawnSync(['bun', '-e', "await import('./src/lib/flows/flow-executor.ts')"], {
      cwd: new URL('../../..', import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(run.stderr.toString()).not.toContain('before initialization');
    expect(run.exitCode).toBe(0);
  });
});

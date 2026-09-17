/**
 * Unit coverage for script-runner.ts — runScript() wraps user code as an edge
 * handler and executes it in the SUBPROCESS sandbox. Real execution, no mocks,
 * except where a runner failure has to be forced.
 *
 * (This module was effectively dead until the sandbox strict-mode bug was fixed
 * in #79 — the runner 500'd on every call, so runScript never returned output.)
 *
 * It ran on the in-process Worker until a flow script that allocated without
 * bound was measured taking the whole engine down with SIGKILL. See the note at
 * the top of script-runner.ts.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as subprocessRunner from '../../lib/edge-functions/subprocess-runner.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript', () => {
  it('returns the script output', async () => {
    const res = await runScript('return 40 + 2;');
    expect(res.error).toBeUndefined();
    expect(res.output).toBe(42);
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('exposes the input object to the script', async () => {
    const res = await runScript('return input.x * 2;', { x: 21 });
    expect(res.output).toBe(42);
  });

  it('captures console logs', async () => {
    const res = await runScript('console.log("hello", "world"); return true;');
    expect(res.output).toBe(true);
    // The subprocess runner records a plain `console.log` unprefixed, and tags
    // the other levels ([error]/[warn]/[info]). The Worker used to write
    // '[log] hello world', so flow run logs lose that one prefix with the move.
    expect(res.logs).toContain('hello world');
  });

  it('returns structured output (objects survive JSON round-trip)', async () => {
    const res = await runScript('return { a: 1, b: [2, 3] };');
    expect(res.output).toEqual({ a: 1, b: [2, 3] });
  });

  it('reports an error thrown by the script without throwing itself', async () => {
    const res = await runScript('throw new Error("boom in script");');
    expect(res.output).toBeNull();
    expect(res.error).toContain('boom in script');
  });

  it('blocks dangerous globals inside the script (sandboxed)', async () => {
    const res = await runScript('return typeof process + "," + typeof Bun;');
    expect(res.output).toBe('undefined,undefined');
  });

  it('falls back to the raw body when it is not the { output } envelope', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockResolvedValue({
      ok: true,
      response: { status: 200, body: 'plain-text-output', headers: {} },
      logs: ['runner-log'],
      duration_ms: 1,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.error).toBeUndefined();
      expect(res.output).toBe('plain-text-output');
      expect(res.logs).toContain('runner-log');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the runner error, with the logs it collected before failing', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockResolvedValue({
      ok: false,
      error: 'Out of memory',
      logs: ['[stderr] something on the way down'],
      duration_ms: 7,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('Out of memory');
      expect(res.logs).toContain('[stderr] something on the way down');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a structured error when the runner itself throws', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockRejectedValue(
      new Error('runner crashed'),
    );
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('runner crashed');
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Unit coverage for script-runner.ts — runScript() wraps user code as an edge
 * handler and executes it in the isolated file-based sandbox (sandbox.ts →
 * worker-runner.ts). Real Worker execution, no mocks.
 *
 * (This module was effectively dead until the sandbox strict-mode bug was fixed
 * in #79 — runFunction 500'd on every call, so runScript never returned output.)
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as sandbox from '../../lib/edge-functions/sandbox.js';
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
    expect(res.logs).toContain('[log] hello world');
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

  it('treats a non-JSON worker body as raw output', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockResolvedValue({
      status: 200,
      body: 'plain-text-output',
      logs: ['worker-log'],
      duration_ms: 1,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.error).toBeUndefined();
      expect(res.output).toBe('plain-text-output');
      expect(res.logs).toContain('worker-log');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a structured error when runFunction throws', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockRejectedValue(new Error('worker crashed'));
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('worker crashed');
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      spy.mockRestore();
    }
  });
});

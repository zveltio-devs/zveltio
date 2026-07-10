/**
 * Unit coverage for the subprocess edge sandbox (edge-functions/subprocess-runner.ts).
 *
 * This is the OS-level-isolation mode (EDGE_SANDBOX_MODE=subprocess) required for
 * UNTRUSTED / multi-tenant edge functions — each invocation runs in a fresh Bun
 * process with a minimal env (no DATABASE_URL / secrets) and stdin/stdout IPC.
 *
 * Regression: the subprocess bootstrap compiled the handler via
 * `new AsyncFunction(...names, '"use strict";…')` with `eval` among the names —
 * illegal as a strict-mode parameter — so every subprocess invocation failed with
 * "Invalid parameters or function name in strict mode." (same class as #78).
 *
 * These spawn REAL subprocesses; each test is bounded by its own timeout.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess', () => {
  it('runs a handler in a subprocess and returns its response', async () => {
    const code = `async function handler(request, env) {
      return { status: 201, body: { hi: env.WHO } };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, { WHO: 'sub' }, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(201);
    expect((res.response?.body as { hi: string }).hi).toBe('sub');
  });

  it('captures console logs from the subprocess', async () => {
    const code = `async function handler() {
      console.log('from', 'subprocess');
      return { status: 200, body: 'ok' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.logs).toContain('from subprocess');
  });

  it('rejects code larger than the size cap', async () => {
    const big = `async function handler(){ return {}; } //${'x'.repeat(1024 * 1024 + 10)}`;
    const res = await runEdgeFunctionInSubprocess(big, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/byte limit/i);
  });

  it('reports a transpile error without spawning', async () => {
    const res = await runEdgeFunctionInSubprocess('const x: = ;', REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Transpile error');
  });

  it('fails when the handler is missing', async () => {
    const res = await runEdgeFunctionInSubprocess('const y = 1;', REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/must define/i);
  });

  it('shadows dangerous globals and blocks the .constructor escape in the subprocess', async () => {
    const code = `async function handler() {
      let escaped = false;
      try { (function(){}).constructor('return 1')(); escaped = true; } catch (_) {}
      return {
        status: 200,
        body: { process: typeof process, Bun: typeof Bun, escaped },
      };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.body).toEqual({ process: 'undefined', Bun: 'undefined', escaped: false });
  });

  it('blocks SSRF to internal addresses via safeFetch', async () => {
    const code = `async function handler() {
      await fetch('http://127.0.0.1/admin');
      return { status: 200, body: 'should not reach' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('blocks non-http(s) fetch schemes', async () => {
    const code = `async function handler() {
      await fetch('file:///etc/passwd');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/http\/https|sandbox/i);
  });

  it('allows fetch to a public https URL', async () => {
    const code = `async function handler() {
      const res = await fetch('https://example.com/');
      return { status: 200, body: { status: res.status } };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 15000);
    expect(res.ok).toBe(true);
    expect((res.response?.body as { status: number }).status).toBeGreaterThanOrEqual(200);
  });
});

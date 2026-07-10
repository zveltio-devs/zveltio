/**
 * Unit coverage for runEdgeFunction — the in-process Bun Worker sandbox that
 * executes ADMIN-authored edge functions.
 *
 * These run REAL workers (data:-URL bootstrap) with real TS→JS transpilation,
 * no mocks: a small handler string in, a RunResult out. Covers the success
 * shapes (explicit response object vs bare return), console capture, the
 * transpile-error arm, the missing-handler guard, and the soft execution
 * timeout. No network, no DB.
 */

import { describe, expect, it } from 'bun:test';
import { type EdgeRequest, runEdgeFunction } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = {
  method: 'GET',
  headers: {},
  query: {},
  body: null,
  path: '/',
};

describe('runEdgeFunction', () => {
  it('runs a handler that returns an explicit response object', async () => {
    const code = `async function handler(request, env) {
      return { status: 201, body: { hello: env.NAME }, headers: { 'x-a': '1' } };
    }`;
    const res = await runEdgeFunction(code, REQ, { NAME: 'ada' }, 2000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(201);
    expect((res.response?.body as { hello: string }).hello).toBe('ada');
    expect(res.response?.headers['x-a']).toBe('1');
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('wraps a bare return value as a 200 response', async () => {
    const code = `async function handler() { return 42; }`;
    const res = await runEdgeFunction(code, REQ, {}, 2000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(res.response?.body).toBe(42);
  });

  it('captures console output into logs', async () => {
    const code = `async function handler() {
      console.log('hi', 'there');
      console.error('boom');
      return { status: 200, body: 'ok' };
    }`;
    const res = await runEdgeFunction(code, REQ, {}, 2000);
    expect(res.ok).toBe(true);
    expect(res.logs).toContain('hi there');
    expect(res.logs).toContain('[error] boom');
  });

  it('reads request fields passed into the sandbox', async () => {
    const code = `async function handler(request) {
      return { status: 200, body: { m: request.method, p: request.path } };
    }`;
    const res = await runEdgeFunction(code, { ...REQ, method: 'POST', path: '/x' }, {}, 2000);
    expect((res.response?.body as { m: string; p: string }).m).toBe('POST');
    expect((res.response?.body as { m: string; p: string }).p).toBe('/x');
  });

  it('returns a transpile error for invalid source', async () => {
    const res = await runEdgeFunction('const x: = ;', REQ, {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Transpile error');
    expect(res.logs).toEqual([]);
  });

  it('fails when the code defines no handler function', async () => {
    const res = await runEdgeFunction('const y = 1;', REQ, {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/must define/i);
  });

  it('surfaces an error thrown inside the handler', async () => {
    const code = `async function handler() { throw new Error('kaboom'); }`;
    const res = await runEdgeFunction(code, REQ, {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('kaboom');
  });

  it('enforces the soft execution timeout', async () => {
    const code = `async function handler() { await new Promise(() => {}); }`;
    const res = await runEdgeFunction(code, REQ, {}, 200);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it('still blocks eval via the sandbox lockdown (not via a shadow param)', async () => {
    // 'eval' can't be a strict-mode parameter name, so it is neutralised by
    // lockdownGlobals() making globalThis.eval throw. Prove reaching it fails.
    const code = `async function handler() { return globalThis.eval('1+1'); }`;
    const res = await runEdgeFunction(code, REQ, {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sandbox|blocked|eval/i);
  });
});

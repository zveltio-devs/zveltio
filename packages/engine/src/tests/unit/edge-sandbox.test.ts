/**
 * Unit coverage for the file-based untrusted edge sandbox (edge-functions/
 * sandbox.ts → worker-runner.ts). Runs a REAL Bun Worker per invocation.
 *
 * This is the SSRF-protected sandbox used by script-runner.ts and the extension
 * internals — user code gets safeFetch (private addresses blocked), a captured
 * console, and dangerous globals shadowed. We drive runFunction() with real
 * handler source and assert the RunResult.
 *
 * (Regression: worker-runner compiled the handler via
 * `new Function(...keys, "'use strict';…")` with `eval` among the keys AND a
 * `const eval = undefined` in the injected prefix — both illegal in strict mode,
 * so every invocation failed with "Invalid parameters or function name in strict
 * mode." until fixed.)
 */

import { describe, expect, it } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

function req(method = 'GET', body?: string): Request {
  return new Request('https://fn.local/run', {
    method,
    ...(body ? { body } : {}),
  });
}

describe('runFunction (file-based sandbox)', () => {
  it('runs a handler and returns its Response status + body', async () => {
    const code = `async function handler(ctx) {
      return new Response(JSON.stringify({ ok: true, method: ctx.request.method }), {
        status: 201,
      });
    }`;
    const res = await runFunction(code, req('POST', '{}'), {}, 5000);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ ok: true, method: 'POST' });
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('captures console output into logs', async () => {
    const code = `async function handler() {
      console.log('hello', 'world');
      console.error('nope');
      return new Response('ok');
    }`;
    const res = await runFunction(code, req(), {}, 5000);
    expect(res.status).toBe(200);
    expect(res.logs).toContain('[log] hello world');
    expect(res.logs).toContain('[err] nope');
  });

  it('exposes env to the handler', async () => {
    const code = `async function handler(ctx) {
      return new Response(ctx.env.GREETING ?? 'none');
    }`;
    const res = await runFunction(code, req(), { GREETING: 'salut' }, 5000);
    expect(res.body).toBe('salut');
  });

  it('returns 500 when no handler is defined', async () => {
    const res = await runFunction('const x = 1;', req(), {}, 5000);
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/handler/i);
  });

  it('surfaces an error thrown inside the handler as 500', async () => {
    const code = `async function handler() { throw new Error('boom-inside'); }`;
    const res = await runFunction(code, req(), {}, 5000);
    expect(res.status).toBe(500);
    expect(res.error).toContain('boom-inside');
  });

  it('blocks SSRF to internal addresses via safeFetch', async () => {
    const code = `async function handler() {
      await fetch('http://127.0.0.1/admin');
      return new Response('should not reach');
    }`;
    const res = await runFunction(code, req(), {}, 5000);
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('enforces the execution timeout with a 504', async () => {
    const code = `async function handler() { while (true) {} }`;
    const res = await runFunction(code, req(), {}, 300);
    expect(res.status).toBe(504);
    expect(res.error).toMatch(/timed out/i);
  });

  it('shadows dangerous globals so user code sees them as undefined', async () => {
    const code = `async function handler() {
      return new Response(JSON.stringify({
        process: typeof process,
        Bun: typeof Bun,
        globalThis: typeof globalThis,
        thisVal: (function(){ return typeof this; })(),
      }));
    }`;
    const res = await runFunction(code, req(), {}, 5000);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      process: 'undefined',
      Bun: 'undefined',
      globalThis: 'undefined',
      thisVal: 'undefined', // strict mode → no global `this` leak
    });
  });

  it('blocks require(), dynamic import(), and new Function() escapes', async () => {
    // require is undefined at the call site; import()/Function are neutralised by
    // the shadow params + lockdownGlobals(). Each attempt must fail closed.
    for (const attempt of [
      `require('os').hostname()`,
      `(await import('fs')).readFileSync`,
      `new Function('return 1')()`,
    ]) {
      const code = `async function handler() {
        try { const r = ${attempt}; return new Response('ESCAPED:' + String(r)); }
        catch (e) { return new Response('BLOCKED'); }
      }`;
      const res = await runFunction(code, req(), {}, 5000);
      expect(res.body).toBe('BLOCKED');
    }
  });

  it('blocks the .constructor reflective-escape trick via lockdownGlobals', async () => {
    // Classic sandbox escape: reach the Function constructor off a function
    // prototype to build `return process`. lockdownGlobals() must still neutralise it.
    const code = `async function handler() {
      const f = (function(){}).constructor('return typeof process');
      return new Response(String(f()));
    }`;
    const res = await runFunction(code, req(), {}, 5000);
    expect(res.status).toBe(500);
  });
});

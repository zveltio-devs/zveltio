/**
 * subprocess-runner SSRF — alternate host encodings (_normalizeHost branches).
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — SSRF host variants', () => {
  it('blocks decimal-encoded loopback addresses', async () => {
    const code = `async function handler() {
      await fetch('http://2130706433/');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('blocks octal-encoded private addresses', async () => {
    const code = `async function handler() {
      await fetch('http://0177.0.0.1/');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('blocks IPv4-mapped IPv6 loopback', async () => {
    const code = `async function handler() {
      await fetch('http://[::ffff:127.0.0.1]/');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });
});

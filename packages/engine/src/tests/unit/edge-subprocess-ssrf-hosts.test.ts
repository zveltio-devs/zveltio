/**
 * subprocess-runner SSRF — hex-encoded hosts and docker/k8s hostnames.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — SSRF host blocks', () => {
  it('blocks hex-encoded private IPv4 addresses', async () => {
    const code = `async function handler() {
      await fetch('http://0xc0a80001/');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('blocks host.docker.internal', async () => {
    const code = `async function handler() {
      await fetch('http://host.docker.internal/api');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });

  it('blocks kubernetes.default service hostname', async () => {
    const code = `async function handler() {
      await fetch('https://kubernetes.default/api');
      return { status: 200, body: 'nope' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked|sandbox/i);
  });
});

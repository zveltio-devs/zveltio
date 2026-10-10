/**
 * RFC extension-runner step 10: an edge function's fetch goes through the
 * ENGINE, held to the function's ZVELTIO_EGRESS list and the SSRF guard on
 * every hop. The runner is `routeConnection` on a socket in this process, as in
 * edge-runner-transport.test.ts; the network under the guard is a stub on this
 * process's globalThis.fetch, which the sandbox cannot see — so a request only
 * reaches it by crossing the bridge. The docker proof that the runner itself has
 * no network is ext-runner-compose.sh.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  drainRunnerPool,
  edgeTransport,
  runEdgeFunctionInSubprocess,
  serveEdgeConnection,
} from '../../lib/edge-functions/subprocess-runner.js';
import { forgetEdgeRunner, routeConnection } from '../../lib/ext-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const dir = mkdtempSync(join(tmpdir(), 'zv-edge-egress-test-'));
const sock = join(dir, 'runner.sock');
let server: Server;
const VARS = [
  'ZVELTIO_EDGE_TRANSPORT',
  'ZVELTIO_EXT_RUNNER_SOCKET',
  'ZVELTIO_EXT_TRANSPORT',
  'NODE_ENV',
] as const;
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const realFetch = globalThis.fetch;

/**
 * The authority a request was addressed to. The guard may pin the connection to
 * the address it resolved (Host header kept) — and another test file in the
 * same run mocks the resolver — so the URL alone can be an IP.
 */
const hostOf = (s: { url: string; headers: Headers }) =>
  s.headers.get('host') ?? new URL(s.url).host;

/** What reached the network under the guard. */
let seen: { url: string; method: string; body: string; headers: Headers }[] = [];

function stubNetwork() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as Uint8Array).toString() : '';
    seen.push({ url, method: init?.method ?? 'GET', body, headers });
    const path = new URL(url).pathname;
    if (path === '/to-unlisted') {
      return new Response(null, { status: 302, headers: { location: 'https://other.test/' } });
    }
    if (path === '/to-metadata') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }
    if (path === '/to-listed') {
      return new Response(null, { status: 302, headers: { location: '/landed' } });
    }
    if (path === '/huge') return new Response(new Uint8Array(6 * 1024 * 1024));
    return new Response(`hello ${path} ${body}`, {
      status: 201,
      headers: { 'x-upstream': 'yes', 'content-type': 'text/plain' },
    });
  }) as typeof fetch;
}

/** A function that fetches `env.url` and reports what came back. */
const PROBE = `async function handler(request, env) {
  try {
    const init = env.method ? { method: env.method, body: env.body, headers: { 'x-mine': '1' } } : {};
    const res = await fetch(env.url, init);
    return { status: 200, body: { status: res.status, text: await res.text(), up: res.headers.get('x-upstream') } };
  } catch (e) {
    return { status: 200, body: { denied: String(e && e.message) } };
  }
}`;

interface Probed {
  status?: number;
  text?: string;
  up?: string;
  denied?: string;
  error?: string;
}

async function call(env: Record<string, string>): Promise<Probed> {
  const res = await runEdgeFunctionInSubprocess(PROBE, REQ, env, 5000);
  if (!res.ok) return { error: res.error };
  return res.response?.body as Probed;
}

function restore() {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
}

beforeAll(async () => {
  server = createServer((conn) =>
    routeConnection(conn, {
      workerArgv: ['cat'],
      childEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      wrap: (argv) => ({ argv }),
      serveEdge: serveEdgeConnection,
    }),
  );
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  stubNetwork();
});

beforeEach(() => {
  seen = [];
  restore();
  process.env.ZVELTIO_EXT_RUNNER_SOCKET = sock;
  forgetEdgeRunner();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  restore();
  forgetEdgeRunner();
  await drainRunnerPool();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

for (const transport of ['runner', 'process'] as const) {
  describe(`egress through the engine (${transport})`, () => {
    beforeEach(() => {
      process.env.ZVELTIO_EDGE_TRANSPORT = transport;
    });

    it('reaches a listed host: method, body, headers and the answer cross the bridge', async () => {
      const out = await call({
        ZVELTIO_EGRESS: 'api.allowed.test, hooks.allowed.test',
        url: 'https://api.allowed.test/x',
        method: 'POST',
        body: 'ping',
      });
      expect(out).toEqual({ status: 201, text: 'hello /x ping', up: 'yes' });
      expect(seen).toHaveLength(1);
      expect(hostOf(seen[0])).toBe('api.allowed.test');
      expect(new URL(seen[0].url).pathname).toBe('/x');
      expect(seen[0].method).toBe('POST');
      expect(seen[0].headers.get('x-mine')).toBe('1');
    }, 20_000);

    it('refuses a host that is not listed, before it is resolved or reached', async () => {
      const out = await call({ ZVELTIO_EGRESS: 'api.allowed.test', url: 'https://other.test/' });
      expect(out.denied).toContain("other.test is not in this function's ZVELTIO_EGRESS");
      expect(seen).toEqual([]);
    }, 20_000);

    it('refuses a private address even when it is listed (SSRF guard)', async () => {
      const out = await call({ ZVELTIO_EGRESS: '127.0.0.1', url: 'http://127.0.0.1/' });
      expect(out.denied).toContain('internal/private address blocked');
      expect(seen).toEqual([]);
    }, 20_000);

    it('holds every redirect hop to the list and the guard', async () => {
      const list = { ZVELTIO_EGRESS: 'api.allowed.test, 169.254.169.254' };
      const unlisted = await call({ ...list, url: 'https://api.allowed.test/to-unlisted' });
      expect(unlisted.denied).toContain('other.test is not in');
      const metadata = await call({ ...list, url: 'https://api.allowed.test/to-metadata' });
      expect(metadata.denied).toContain('internal/private address blocked');
      expect(seen.map(hostOf)).toEqual(['api.allowed.test', 'api.allowed.test']);

      const followed = await call({ ...list, url: 'https://api.allowed.test/to-listed' });
      expect(followed).toMatchObject({ status: 201, text: 'hello /landed ' });
    }, 30_000);

    it('matches the port exactly: a bare host is the default port only', async () => {
      const bare = await call({
        ZVELTIO_EGRESS: 'api.allowed.test',
        url: 'https://api.allowed.test:8443/',
      });
      expect(bare.denied).toContain('api.allowed.test:8443 is not in');
      const ported = await call({
        ZVELTIO_EGRESS: 'api.allowed.test:8443',
        url: 'https://api.allowed.test:8443/p',
      });
      expect(ported).toMatchObject({ status: 201 });
      const scheme = await call({
        ZVELTIO_EGRESS: 'api.allowed.test',
        url: 'ftp://api.allowed.test/',
      });
      expect(scheme.denied).toBeDefined();
      expect(seen).toHaveLength(1);
    }, 30_000);

    it('bounds the response it hands back', async () => {
      const out = await call({
        ZVELTIO_EGRESS: 'api.allowed.test',
        url: 'https://api.allowed.test/huge',
      });
      expect(out.denied).toContain('response exceeds');
    }, 20_000);
  });
}

describe('egress declarations', () => {
  it('a function without ZVELTIO_EGRESS reaches nothing on the runner', async () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    const out = await call({ url: 'https://api.allowed.test/' });
    expect(out.denied).toContain('declares no egress');
    const empty = await call({ ZVELTIO_EGRESS: '', url: 'https://api.allowed.test/' });
    expect(empty.denied).toContain('declares no egress');
    expect(seen).toEqual([]);
  }, 20_000);

  it('refuses to run with an entry that is not a host', async () => {
    for (const bad of ['https://api.allowed.test', '*.allowed.test', 'api.allowed.test/x']) {
      const out = await call({ ZVELTIO_EGRESS: bad, url: 'https://api.allowed.test/' });
      expect(out).toEqual({ error: expect.stringContaining('is not a host') });
    }
  }, 20_000);

  it('caps requests per invocation', async () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    const res = await runEdgeFunctionInSubprocess(
      `async function handler(request, env) {
        let ok = 0, refused = '';
        for (let i = 0; i < 52; i++) {
          try { await fetch('https://api.allowed.test/' + i); ok++; } catch (e) { refused = e.message; }
        }
        return { ok, refused };
      }`,
      REQ,
      { ZVELTIO_EGRESS: 'api.allowed.test' },
      10_000,
    );
    expect(res.response?.body).toEqual({
      ok: 50,
      refused: '[egress] more than 50 requests in one invocation',
    });
  }, 30_000);

  it('a declared function defaults to where extensions run; an undeclared one stays local', () => {
    delete process.env.ZVELTIO_EDGE_TRANSPORT;
    process.env.NODE_ENV = 'production';
    expect(edgeTransport(['api.allowed.test'])).toBe('runner');
    expect(edgeTransport([])).toBe('runner');
    expect(edgeTransport(null)).toBe('process');
    process.env.NODE_ENV = 'development';
    expect(edgeTransport(['api.allowed.test'])).toBe('process');
    process.env.ZVELTIO_EXT_TRANSPORT = 'runner';
    expect(edgeTransport(['api.allowed.test'])).toBe('runner');
    // The operator's switch wins both ways.
    process.env.ZVELTIO_EDGE_TRANSPORT = 'process';
    expect(edgeTransport(['api.allowed.test'])).toBe('process');
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    expect(edgeTransport(null)).toBe('runner');
  });

  it('by default, a declared function crosses the runner in production', async () => {
    delete process.env.ZVELTIO_EDGE_TRANSPORT;
    process.env.NODE_ENV = 'production';
    // The runner socket goes away: a declared function now fails to reach it,
    // which proves it was sent there, and an undeclared one still runs locally.
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = join(dir, 'missing.sock');
    const declared = await call({
      ZVELTIO_EGRESS: 'api.allowed.test',
      url: 'https://api.allowed.test/',
    });
    expect(declared).toEqual({ error: expect.stringContaining('missing.sock') });
    const undeclared = await runEdgeFunctionInSubprocess(
      'async function handler() { return 7; }',
      REQ,
      {},
      5000,
    );
    expect(undeclared).toMatchObject({ ok: true, response: { body: 7 } });
  }, 20_000);
});

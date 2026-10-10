/**
 * WorkerExtensionHost — Hono proxy forwards request headers to route:invoke.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import {
  WorkerExtensionHost,
  type WorkerCtxSource,
  _internalForTests,
  workerRequestHeaders,
} from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy, resetInvokeWaiters } = _internalForTests;

afterEach(() => resetInvokeWaiters());

/** The headers a worker receives for one request through the host proxy. */
async function headersSeen(
  path: string,
  headers: Record<string, string>,
  source: WorkerCtxSource = {},
): Promise<Record<string, string> | undefined> {
  const app = new Hono();
  const host = new WorkerExtensionHost(app);
  let captured: Record<string, string> | undefined;
  const managed = {
    name: 'cred-ext',
    worker: {
      postMessage: (msg: HostToWorkerMessage) => {
        if (msg.type !== 'route:invoke') return;
        captured = msg.headers;
        queueMicrotask(() =>
          dispatchMessage(host, managed as never, { type: 'route:ok', id: msg.id, status: 200 }),
        );
      },
      terminate: () => {},
    },
    routes: [
      { method: 'POST', path: '/hook/:id' },
      { method: 'POST', path: '/private' },
    ],
    pendingInvokes: new Map(),
    invokeTenants: new Map(),
    source,
  };
  // @ts-expect-error — test seam into private map
  host.workers.set('cred-ext', managed);
  mountProxy(host, managed as never);
  const res = await app.request(`/ext/cred-ext${path}`, { method: 'POST', headers });
  expect(res.status).toBe(200);
  return captured;
}

const CREDENTIALS = {
  Cookie: 'better-auth.session_token=s3cret',
  Authorization: 'Bearer zvk_live_key',
  'Proxy-Authorization': 'Basic cHJveHk=',
  'X-API-Key': 'zvk_other_key',
};
const SIGNATURES = {
  'Stripe-Signature': 't=1,v1=abc',
  'X-Hub-Signature': 'sha1=def',
  'X-Hub-Signature-256': 'sha256=0123',
};

describe('WorkerExtensionHost — caller credentials stay with the host', () => {
  it('strips cookie, authorization, proxy-authorization and x-api-key; signatures pass', async () => {
    const seen = await headersSeen('/hook/1', { ...CREDENTIALS, ...SIGNATURES });
    for (const k of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key']) {
      expect(seen?.[k]).toBeUndefined();
    }
    expect(seen?.['stripe-signature']).toBe('t=1,v1=abc');
    expect(seen?.['x-hub-signature']).toBe('sha1=def');
    expect(seen?.['x-hub-signature-256']).toBe('sha256=0123');
  });

  it('forwards only the named credential, only on the route that declares it', async () => {
    const source = { forwardCredentials: { '/hook/*': ['authorization'] } };
    const hook = await headersSeen('/hook/1', CREDENTIALS, source);
    expect(hook?.authorization).toBe('Bearer zvk_live_key');
    expect(hook?.cookie).toBeUndefined();
    expect(hook?.['x-api-key']).toBeUndefined();
    const other = await headersSeen('/private', CREDENTIALS, source);
    expect(other?.authorization).toBeUndefined();
  });

  it('matches credential names case-insensitively', () => {
    const raw = new Headers({ AUTHORIZATION: 'x', 'X-Api-KEY': 'y', 'X-Other': 'z' });
    expect(workerRequestHeaders(raw)).toEqual({ 'x-other': 'z' });
    expect(workerRequestHeaders(raw, new Set(['x-api-key']))).toEqual({
      'x-api-key': 'y',
      'x-other': 'z',
    });
  });
});

describe('WorkerExtensionHost — proxy header forwarding', () => {
  it('includes incoming request headers on route:invoke', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    let capturedHeaders: Record<string, string> | undefined;

    const managed = {
      name: 'hdr-ext',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: {
        postMessage: (msg: HostToWorkerMessage) => {
          if (msg.type === 'route:invoke') {
            capturedHeaders = msg.headers;
            queueMicrotask(() => {
              dispatchMessage(host, managed, {
                type: 'route:ok',
                id: msg.id,
                status: 200,
                body: 'ok',
              });
            });
          }
        },
        terminate: () => {},
      } as unknown as Worker,
      routes: [{ method: 'POST', path: '/echo' }],
      pendingInvokes: new Map(),
      invokeTenants: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set<string>(),
      dependencies: new Set<string>(),
      mayCall: new Map<string, boolean>(),
      proxyUnmount: () => {},
      workerGeneration: 1,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      stopped: false,
    };
    // @ts-expect-error — test seam into private map
    host.workers.set('hdr-ext', managed);

    mountProxy(host, managed);

    const res = await app.request('/ext/hdr-ext/echo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Token': 'abc123',
      },
      body: '{"hello":true}',
    });

    expect(res.status).toBe(200);
    expect(capturedHeaders?.['x-custom-token']).toBe('abc123');
    expect(capturedHeaders?.['content-type']).toContain('application/json');
  });
});

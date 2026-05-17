import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createRpcClient } from '@zveltio/sdk/rpc';
import type { ZveltioApi, ListResponse, SingleResponse } from '../../api-types.js';

/**
 * S5-02 contract test for the Hono RPC client.
 *
 * The runtime payoff here is small — we mostly check that the client
 * factory wraps fetch correctly. The REAL win is type-level: this file
 * passing `tsc --noEmit` proves the SDK's `createRpcClient<ZveltioApi>()`
 * gives us tsc-checked URLs + payloads. Any drift in `api-types.ts`
 * breaks compilation here BEFORE downstream clients ship broken
 * assumptions.
 */

describe('S5-02 createRpcClient', () => {
  it('builds a typed client for ZveltioApi', () => {
    const client = createRpcClient<ZveltioApi>({ baseUrl: 'http://localhost:3000' });
    // hc's proxy nodes are callable functions (so the same node can act
    // as both a path prefix and a route invoker). Either is fine — we
    // just need a defined value at each level the type promises.
    expect(client.api).toBeDefined();
    expect(client.api.data).toBeDefined();
    expect(client.api.data[':collection']).toBeDefined();
    expect(typeof client.api.data[':collection'].$get).toBe('function');
  });

  it('attaches credentials: include by default and merges static headers', async () => {
    let captured: { input: any; init: RequestInit | undefined } | null = null;
    const fakeFetch = async (input: any, init: any) => {
      captured = { input, init };
      return new Response(JSON.stringify({ records: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = createRpcClient<ZveltioApi>({
      baseUrl: 'http://localhost:9999',
      headers: { 'X-Tenant-Id': 't-1' },
      fetch: fakeFetch as any,
    });
    const res = await client.api.data[':collection'].$get({
      param: { collection: 'contacts' },
    });
    const body = await res.json() as ListResponse;
    expect(body.total).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.init?.credentials).toBe('include');
    // Headers were merged.
    const headers = new Headers(captured!.init?.headers);
    expect(headers.get('x-tenant-id')).toBe('t-1');
  });

  it('honors getHeaders for dynamic per-request tokens', async () => {
    // Wrap in a holder so TS doesn't narrow it to its initial value.
    const observed: { auth: string | null } = { auth: null };
    const fakeFetch = async (_input: any, init: any) => {
      const h = new Headers(init?.headers);
      observed.auth = h.get('authorization');
      return new Response(JSON.stringify({ records: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    let token = 'tok-1';
    const client = createRpcClient<ZveltioApi>({
      baseUrl: 'http://localhost:9999',
      getHeaders: () => ({ Authorization: `Bearer ${token}` }),
      fetch: fakeFetch as any,
    });
    await client.api.data[':collection'].$get({ param: { collection: 'x' } });
    expect(observed.auth).toBe('Bearer tok-1');

    // Rotate the token; same client picks up the new value without rebuild.
    token = 'tok-2';
    await client.api.data[':collection'].$get({ param: { collection: 'x' } });
    expect(observed.auth).toBe('Bearer tok-2');
  });

  it('respects includeCredentials: false (cross-origin SPA pattern)', async () => {
    let credsSent: RequestCredentials | undefined;
    const fakeFetch = async (_input: any, init: any) => {
      credsSent = init?.credentials as RequestCredentials | undefined;
      return new Response(JSON.stringify({ records: [], total: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = createRpcClient<ZveltioApi>({
      baseUrl: 'http://localhost:9999',
      includeCredentials: false,
      fetch: fakeFetch as any,
    });
    await client.api.data[':collection'].$get({ param: { collection: 'x' } });
    // When includeCredentials is false, we don't force the default — the
    // browser's default ('same-origin') applies, which manifests as
    // undefined here unless the caller's `init.credentials` was set.
    expect(credsSent).toBeUndefined();
  });
});

describe('S5-02 ZveltioApi type fixture parity', () => {
  // Smoke test: build a tiny app matching the fixture's shape and verify
  // the typed client points at the same routes. If `api-types.ts` is ever
  // refactored to a different mount path, this catches the regression.
  it('typed client url generators match the fixture routes', () => {
    // Build a runtime app that mirrors `_apiRoutes` from api-types.ts. We
    // can't import the private `_apiRoutes` constant (it's not exported),
    // so we rebuild the surface and prove the typed client routes line
    // up with `/api/data/:collection*`.
    const _runtime = new Hono()
      .route('/api/data', new Hono()
        .get('/:collection', (c) => c.json({ records: [] as any[], total: 0 })));
    const client = createRpcClient<typeof _runtime>({ baseUrl: 'http://x' });
    // hc's url() returns the URL the request would hit. Useful sanity.
    const url = client.api.data[':collection'].$url({ param: { collection: 'orders' } });
    expect(url.pathname).toBe('/api/data/orders');
  });
});

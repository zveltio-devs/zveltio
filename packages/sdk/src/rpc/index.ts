/**
 * Typed Hono RPC client factory.
 *
 * Returns a Hono-typed client (via `hono/client#hc`) parameterized by the
 * engine's `AppType`. Callers get autocomplete + tsc-checked URLs + typed
 * request/response shapes for every route they hit.
 *
 *   import { createRpcClient } from '@zveltio/sdk/rpc';
 *   import type { ZveltioApi } from '@zveltio/engine/api-types';
 *
 *   const client = createRpcClient<ZveltioApi>({ baseUrl: 'http://localhost:3000' });
 *
 *   // Typed call — autocomplete on `.api.data[':collection'].$post()` and
 *   // input/output payloads match the engine's route definition.
 *   const res = await client.api.data[':collection'].$post({
 *     param: { collection: 'contacts' },
 *     json: { email: 'a@b.com', name: 'Alice' },
 *   });
 *
 * Why this lives in the SDK and not the engine:
 *   - The runtime is tiny — `hc()` is a thin wrapper around `fetch`. No
 *     reason to duplicate it in every extension. SDK is the natural home.
 *   - The TYPE comes from the engine (whichever AppType the consumer
 *     wants to bind against). Extensions can also bind their OWN typed
 *     Hono routes — the factory is type-generic.
 *
 * Wraps `hc()` with two ergonomic additions:
 *   - `credentials: 'include'` by default so cookie-auth works without
 *     boilerplate at every call site.
 *   - Optional `headers` factory called per-request so auth tokens that
 *     change (e.g. CSRF) can flow without rebuilding the client.
 */

import { hc } from 'hono/client';
import type { Hono } from 'hono';

export interface RpcClientOptions {
  /** Base URL of the engine. Required; no default so misconfiguration fails loud. */
  baseUrl: string;
  /**
   * Static headers attached to every request. For dynamic per-request
   * headers (auth tokens, CSRF), pass `getHeaders` instead.
   */
  headers?: Record<string, string>;
  /** Async/sync function called before each request; result merged into headers. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Forward cookies on every request. Defaults to `true` so session-based
   * auth (the common case for Studio + extensions on the same origin)
   * works out of the box. Set `false` for cross-origin SPAs that prefer
   * bearer tokens.
   */
  includeCredentials?: boolean;
  /**
   * Override the global `fetch`. Mostly useful in tests (mock fetch) or
   * server-side rendering where you want to attach the user's cookie to
   * a server-issued request.
   */
  fetch?: typeof fetch;
}

/**
 * Build a Hono RPC client for the given app type.
 *
 * @typeParam T  The Hono app type. For the Zveltio engine, import
 *               `ZveltioApi` from `@zveltio/engine/api-types`. For an
 *               extension's own routes, pass `typeof yourApp`.
 */
export function createRpcClient<T extends Hono<any, any, any>>(
  opts: RpcClientOptions,
): ReturnType<typeof hc<T>> {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const includeCredentials = opts.includeCredentials !== false;

  const customFetch = (async (input: any, init: any) => {
    const dynHeaders = opts.getHeaders ? await opts.getHeaders() : {};
    const merged = new Headers(init?.headers ?? {});
    for (const [k, v] of Object.entries(opts.headers ?? {})) merged.set(k, v);
    for (const [k, v] of Object.entries(dynHeaders)) merged.set(k, v);
    return (opts.fetch ?? fetch)(input, {
      ...init,
      headers: merged,
      credentials: includeCredentials ? 'include' : init?.credentials,
    });
    // Bun's `typeof fetch` includes a `preconnect` static which our wrapper
    // doesn't reasonably proxy. Cast to silence — at call time hc() only
    // invokes the function form.
  }) as unknown as typeof fetch;

  return hc<T>(baseUrl, { fetch: customFetch });
}

// Re-export the InferRequestType / InferResponseType helpers so consumers
// can declare typed wrappers without a second import line.
export type { InferRequestType, InferResponseType } from 'hono/client';

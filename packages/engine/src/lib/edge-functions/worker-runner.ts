/// <reference types="bun-types" />

/**
 * Edge function worker runner — executes user code in an isolated Bun Worker thread.
 * This file runs in a separate thread, preventing infinite loops from freezing the server.
 *
 * Security hardening:
 *   - SSRF protection: fetch is replaced with safeFetch that blocks internal/private addresses
 *   - Prototype pollution prevention: dangerous globals are explicitly blocked
 *   - Security prefix injected into user code to shadow dangerous identifiers
 */

import { validatePublicUrl } from '../security/index.js';

interface WorkerPayload {
  code: string;
  requestData: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
  env: Record<string, string>;
}

// STDLIB is eliminated — _logs and console are injected via safeGlobals as parameters.
// Redeclaring them in the function body with 'use strict' active causes SyntaxError.
const _STDLIB = ''; // kept for compatibility — content moved to safeGlobals

/**
 * Secure fetch that blocks requests to internal/private networks.
 * Prevents SSRF attacks from Edge Functions.
 * Handles octal/decimal/hex IP variants to prevent bypass.
 */
const safeFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  _hops = 0,
): Promise<Response> => {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    throw new Error('Invalid fetch input');
  }

  // SSRF gate — delegate to the single consolidated validator instead of a
  // bespoke prefix list. It rejects non-http(s) schemes, malformed URLs, every
  // IPv4 encoding (hex/octal/decimal/mapped) AND the IPv6 loopback/link-local/
  // ULA/IPv4-mapped forms the old prefix list missed (an edge function could
  // reach http://[::1] or IPv6-mapped cloud metadata otherwise).
  try {
    validatePublicUrl(url);
  } catch (e) {
    throw new Error(
      `[Zveltio Sandbox] Network access blocked: ${(e as Error).message}. ` +
        `Edge Functions can only access public internet endpoints.`,
    );
  }

  if (_hops > 5) throw new Error('[Zveltio Sandbox] Too many redirects.');

  // Prevent redirect-based SSRF: intercept redirects and re-validate the Location URL.
  const response = await fetch(input, { ...(init ?? {}), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location)
      throw new Error('[Zveltio Sandbox] Redirect with no Location header blocked for security.');
    // Re-validate the redirect target — blocks chains like public.example.com → 169.254.169.254
    return safeFetch(new URL(location, url).toString(), init, _hops + 1);
  }

  return response;
};

// ═══ Security prefix injected before user code ═══
// The dangerous globals (process, require, Bun, globalThis, …) are shadowed as
// `undefined` PARAMETERS via safeGlobals below — so this prefix must NOT also
// `const`-declare them: a param + a same-named `const` under 'use strict' is a
// "Cannot declare a const variable twice" error, and `const eval`/`eval` as a
// param name is an "Invalid parameters in strict mode" error. Both bugs made
// EVERY sandbox invocation fail to compile (→ 500) until this was corrected.
// lockdownGlobals() is the real enforcement; the params are UX shadowing.
//
// The only thing left here is the per-call fetch timeout. safeFetch (SSRF-safe)
// is passed in as `__zvSafeFetch` so we can wrap it and expose the wrapper as
// `fetch` without colliding with a `fetch` parameter.
const SECURITY_PREFIX = `
'use strict';
let _timeoutFired = false;
const _wrapFetch = (input, init) => {
  if (_timeoutFired) throw new Error('Function execution timeout - fetch not allowed');
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => {
      _timeoutFired = true;
      reject(new Error('Fetch timeout'));
    }, 5000)
  );
  return Promise.race([__zvSafeFetch(input, init), timeoutPromise]);
};
const fetch = _wrapFetch;
`;

self.onmessage = async (e: MessageEvent<WorkerPayload>) => {
  const { code, requestData, env } = e.data;
  const logs: string[] = [];
  const start = Date.now();

  try {
    // ═══ Sandbox lockdown — runs ONCE per Worker, BEFORE user code is
    //     compiled or evaluated. Replaces Bun/process/Function/eval on
    //     globalThis with non-configurable throwing getters and replaces
    //     the .constructor slot on every function prototype with a
    //     throwing stub. After this point, `(()=>{}).constructor("return Bun")()`
    //     and equivalents fail closed at runtime.
    const { lockdownGlobals } = await import('./sandbox-lockdown.js');
    // Transpile FIRST while Bun.Transpiler is still reachable — lockdown
    // makes `Bun` throw, so any later access from this file would crash too.
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const js = transpiler.transformSync(code);
    // Stash the real Function constructor so we can still build the
    // user handler closure ourselves below; lockdown disables ALL future
    // access via the prototype chain.
    const FunctionCtor = Function;
    lockdownGlobals();

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const safeGlobals: Record<string, any> = {
      // ═══ Allowed globals ═══
      // SSRF-protected proxy (NOT raw fetch). Exposed to user code as `fetch`
      // via the timeout wrapper in SECURITY_PREFIX — passed under this name so
      // the wrapper can reference it without a `fetch`-param name collision.
      __zvSafeFetch: safeFetch,
      Request,
      Response,
      URL,
      URLSearchParams,
      Headers,
      crypto,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      _logs: logs,
      console: {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        log: (...args: any[]) => logs.push(`[log] ${args.join(' ')}`),
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        error: (...args: any[]) => logs.push(`[err] ${args.join(' ')}`),
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        warn: (...args: any[]) => logs.push(`[warn] ${args.join(' ')}`),
      },

      // ═══ Defense in depth: shadow names as params even though lockdown
      //     already blocks property access. A user trying to type `process`
      //     gets `undefined` instead of throwing — matches the documented
      //     "these aren't available" UX while keeping the real lockdown
      //     for any reflective access. ═══
      process: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
      global: undefined,
      globalThis: undefined,
      Bun: undefined,
      Deno: undefined,
      self: undefined,
      postMessage: undefined,
      importScripts: undefined,
      // 'eval' is intentionally omitted — it's illegal as a strict-mode
      // parameter name (Object.keys(safeGlobals) become the Function params),
      // which broke compilation for every invocation. lockdownGlobals() blocks
      // reflective eval access instead.
      Function: undefined,
    };

    const fn = new FunctionCtor(
      ...Object.keys(safeGlobals),
      `${SECURITY_PREFIX}\n${js}; return typeof handler !== 'undefined' ? handler : (typeof module !== 'undefined' ? module.exports?.default : null);`,
    );

    const handler = fn(...Object.values(safeGlobals));

    if (typeof handler !== 'function') {
      self.postMessage({
        success: false,
        error: 'Function must export a default handler',
        logs,
        duration_ms: Date.now() - start,
        status: 500,
        body: '',
      });
      return;
    }

    const request = new Request(requestData.url, {
      method: requestData.method,
      headers: new Headers(requestData.headers),
      body: requestData.body ?? undefined,
    });

    const ctx = { request, env };
    const result: Response = await handler(ctx);
    const body = await result.text();

    self.postMessage({
      success: true,
      status: result.status,
      body,
      logs,
      duration_ms: Date.now() - start,
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    self.postMessage({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      duration_ms: Date.now() - start,
      status: 500,
      body: '',
    });
  }
};

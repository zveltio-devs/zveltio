export interface EdgeRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  path: string;
}

export interface EdgeResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface RunResult {
  ok: boolean;
  response?: EdgeResponse;
  error?: string;
  logs: string[];
  duration_ms: number;
}

// Worker bootstrap. Runs INSIDE a freshly-spawned Bun Worker (one per
// request). Order matters:
//   1. Capture the real Function/AsyncFunction constructors and `fetch`
//      while they're still reachable.
//   2. Run lockdownGlobals() — see edge-functions/sandbox-lockdown.ts for
//      rationale. After this point, any user-code attempt to reach Bun,
//      process, Worker, eval, Function, or to use the .constructor escape
//      trick on a function prototype, throws.
//   3. Compile the user handler via the captured AsyncFunction constructor
//      with dangerous globals also shadowed as parameters (belt-and-braces
//      against typos that would otherwise just look like undefined values).
//
// SSRF: `fetch` passed to the user is the parent's network primitive — we
// don't have safeFetch reachable from inside a data:-URL Worker, so this
// runner is appropriate only for ADMIN-authored edge functions. Anything
// untrusted should use the file-based sandbox in edge-functions/sandbox.ts
// which mounts safeFetch by import.
const WORKER_BOOTSTRAP = `
'use strict';
const BLOCKED = ['Bun','process','require','module','exports','__dirname','__filename','Worker','importScripts','eval','Function'];
function buildThrower(name) {
  return () => { throw new Error('[sandbox] access to "' + name + '" is blocked'); };
}
function lockdownGlobals() {
  for (const name of BLOCKED) {
    try {
      Object.defineProperty(globalThis, name, {
        get: buildThrower(name),
        set: buildThrower(name),
        configurable: false,
        enumerable: false,
      });
    } catch (_) {
      try { globalThis[name] = buildThrower(name); } catch (_) { /* read-only */ }
    }
  }
  const throwingCtor = function() { throw new Error('[sandbox] dynamic code construction is blocked'); };
  function lockProto(proto) {
    try {
      Object.defineProperty(proto, 'constructor', {
        value: throwingCtor, configurable: false, writable: false, enumerable: false,
      });
    } catch (_) { /* frozen */ }
  }
  lockProto((function(){}).constructor.prototype);
  lockProto(Object.getPrototypeOf(async function(){}));
  lockProto(Object.getPrototypeOf(function*(){}));
  lockProto(Object.getPrototypeOf(async function*(){}));
  try { Object.freeze(Object.prototype); } catch (_) {}
  try { Object.freeze(Array.prototype); } catch (_) {}
  try { Object.freeze(String.prototype); } catch (_) {}
  try { Object.freeze(Number.prototype); } catch (_) {}
  try { Object.freeze(Function.prototype); } catch (_) {}
}

self.onmessage = async (e) => {
  const { id, code, request, env, timeoutMs } = e.data;
  const logs = [];
  const _console = {
    log:   (...a) => logs.push(a.map(String).join(' ')),
    error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
    warn:  (...a) => logs.push('[warn] '  + a.map(String).join(' ')),
    info:  (...a) => logs.push('[info] '  + a.map(String).join(' ')),
  };
  try {
    // Stash constructor + fetch BEFORE lockdown — lockdown disables both.
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const _fetch = fetch;
    lockdownGlobals();

    // NB: 'eval' and 'arguments' are illegal as strict-mode parameter names —
    // listing 'eval' here made the AsyncFunction constructor throw "Invalid
    // parameters in strict mode" for EVERY worker-mode edge function. It's
    // already neutralised by lockdownGlobals() (globalThis.eval throws), so it
    // must not appear in the shadow-parameter list.
    const userFn = new AsyncFn(
      'request','env','console','fetch',
      'process','Bun','require','module','exports','globalThis','Function','Worker','importScripts','self',
      '"use strict";\\n' + code +
      '\\nif (typeof handler !== "function") throw new Error("Edge function must define: async function handler(request, env)");' +
      '\\nreturn handler(request, env);'
    );
    const timeout = new Promise((_,rej) =>
      setTimeout(() => rej(new Error('Execution timed out after ' + timeoutMs + 'ms')), timeoutMs)
    );
    const raw = await Promise.race([
      userFn(request, env, _console, _fetch,
        undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined),
      timeout,
    ]);
    let response;
    if (raw && typeof raw === 'object' && 'status' in raw) {
      response = { status: raw.status ?? 200, body: raw.body ?? null, headers: raw.headers ?? {} };
    } else {
      response = { status: 200, body: raw ?? null, headers: {} };
    }
    self.postMessage({ id, ok: true, response, logs });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message, logs });
  }
};
`;

export async function runEdgeFunction(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  const start = Date.now();

  // Sandbox mode:
  //   - 'worker' (default): in-process Bun Worker. ~1ms startup, suitable
  //     for ADMIN-authored edge functions (single tenant or trusted code).
  //   - 'subprocess': new Bun process per invocation. ~30ms startup but
  //     OS-level isolation — REQUIRED if you let untrusted/end-users author
  //     edge functions in a multi-tenant setup.
  //
  // Operators flip this per deployment by setting `EDGE_SANDBOX_MODE=subprocess`.
  const mode = process.env.EDGE_SANDBOX_MODE === 'subprocess' ? 'subprocess' : 'worker';
  if (mode === 'subprocess') {
    const { runEdgeFunctionInSubprocess } = await import('./edge-functions/subprocess-runner.js');
    return runEdgeFunctionInSubprocess(code, request, envVars, timeoutMs);
  }

  // Transpile TypeScript → JavaScript before sandboxing
  let jsCode: string;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const transpiler = new (Bun as any).Transpiler({ loader: 'ts' });
    jsCode = transpiler.transformSync(code);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    return {
      ok: false,
      error: `Transpile error: ${err.message}`,
      logs: [],
      duration_ms: Date.now() - start,
    };
  }

  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const dataUrl = `data:application/javascript;base64,${btoa(unescape(encodeURIComponent(WORKER_BOOTSTRAP)))}`;
    const worker = new Worker(dataUrl);

    // Hard kill after timeoutMs + 2s — catches cases where the Worker itself hangs
    const hardKill = setTimeout(() => {
      worker.terminate();
      resolve({
        ok: false,
        error: 'Worker hard timeout',
        logs: [],
        duration_ms: Date.now() - start,
      });
    }, timeoutMs + 2000);

    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      clearTimeout(hardKill);
      worker.terminate();
      const duration_ms = Date.now() - start;
      if (e.data.ok) {
        resolve({ ok: true, response: e.data.response, logs: e.data.logs ?? [], duration_ms });
      } else {
        resolve({ ok: false, error: e.data.error, logs: e.data.logs ?? [], duration_ms });
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      clearTimeout(hardKill);
      worker.terminate();
      resolve({ ok: false, error: err.message, logs: [], duration_ms: Date.now() - start });
    };

    worker.postMessage({ id, code: jsCode, request, env: envVars, timeoutMs });
  });
}

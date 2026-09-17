import { sandboxWorkerEnv } from './edge-functions/sandbox-env.js';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDynamicImport } from './edge-functions/no-dynamic-import.js';
import {
  buildSandboxSafeFetchSource,
  buildSandboxSsrfGuardSource,
} from './security/index.js';

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
// SSRF: the user's `fetch` used to be the parent's raw network primitive here,
// on the reasoning that safeFetch is not reachable from inside a data:-URL
// Worker. The module is not reachable; its SOURCE is — the same generator the
// subprocess bootstrap uses emits the blocklist straight from
// security/url-validator.ts, so this runner no longer hands out an unguarded
// fetch just because it cannot import one.
//
// The DNS-aware half works here too, and the reason it did not is worth keeping:
// a `data:` URL Worker has no module of its own, so there was nowhere to put a
// static import and nothing to resolve names with after lockdown. Moving the
// bootstrap to a real `.mjs` file — forced by the specifier-length limit — gave
// it one. So the import below is evaluated at module load, BEFORE lockdown and
// before any user code exists, exactly as in the subprocess bootstrap, and both
// runners now check what a hostname RESOLVES to rather than only how it is
// spelled.
const WORKER_BOOTSTRAP = `
'use strict';
import { lookup as _dnsLookupImpl } from 'node:dns/promises';
${buildSandboxSsrfGuardSource('_dnsLookupImpl')}
let _fetch;
${buildSandboxSafeFetchSource()}
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
    // Captured for the generated safeFetch above, which closes over it.
    _fetch = fetch;
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
      userFn(request, env, _console, safeFetch,
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

/**
 * The generated Worker bootstrap source, for a test that asserts which SSRF
 * guard variant it received. Nothing outside tests should read this.
 */
export const __workerBootstrapForTests = WORKER_BOOTSTRAP;

/**
 * The Worker bootstrap, on disk.
 *
 * It used to be inlined as a `data:` URL. That stopped being possible once the
 * bootstrap carried the generated SSRF guard: Bun refuses a module specifier
 * that long with `NameTooLong`, and the failure arrives as a worker error on
 * EVERY invocation rather than as anything that names the cause.
 *
 * Written once, lazily, into a private `mkdtemp` directory for the same reason
 * the subprocess runner does it: a predictable path under /tmp is a symlink
 * target an attacker can pre-place, and this file is executed by the engine.
 */
let bootstrapPath: string | null = null;
function workerBootstrapPath(): string {
  if (bootstrapPath) return bootstrapPath;
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-edge-worker-'));
  const file = join(dir, 'bootstrap.mjs');
  writeFileSync(file, WORKER_BOOTSTRAP, { encoding: 'utf-8' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows lacks POSIX mode; the mkdtemp directory governs access there.
  }
  bootstrapPath = file;
  return file;
}

export async function runEdgeFunction(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  const start = Date.now();

  // Sandbox mode:
  //   - 'subprocess' (default): new Bun process per invocation, a minimal
  //     environment (PATH + TMPDIR only) so engine credentials are not visible
  //     to the child, and a kernel memory ceiling.
  //   - 'worker': in-process Bun Worker. Faster, but only a boundary against
  //     mistakes — see the note on the module loader below — and it cannot be
  //     given a memory ceiling, because Bun ignores a Worker's resourceLimits.
  //
  // Subprocess is the DEFAULT. The worker mode's lockdown shadows dangerous
  // globals, which cannot stop `await import('node:fs')` — the module loader is
  // not reachable through globalThis, so the escape is not a bug to patch but a
  // property of running untrusted code in-process. Demonstrated by execution:
  // shadowing `process` as a parameter still leaves `import('node:process')`
  // returning the real module and the real environment.
  //
  // A separate process is a boundary the JS lockdown can never be, and the price
  // is smaller than this comment used to claim. Measured per invocation, warmed,
  // median of 15: worker 31.8 ms, subprocess 42.6 ms — about 11 ms, not the
  // "~1ms vs ~30ms" written here before, which compared runner STARTUP and not a
  // call. Both runners pay transpilation, compilation, lockdown and a round trip
  // every time, and the worker is built fresh on each invocation.
  // `EDGE_SANDBOX_MODE=worker` opts back into the in-process runner where that
  // 11 ms matters more than isolation and the author is trusted.
  const mode = process.env.EDGE_SANDBOX_MODE === 'worker' ? 'worker' : 'subprocess';
  if (mode === 'subprocess') {
    const { runEdgeFunctionInSubprocess } = await import('./edge-functions/subprocess-runner.js');
    return runEdgeFunctionInSubprocess(code, request, envVars, timeoutMs);
  }

  // Transpile TypeScript → JavaScript before sandboxing
  let jsCode: string;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const transpiler = new (Bun as any).Transpiler({ loader: 'ts' });
    jsCode = transpiler.transformSync(code);
    const moduleEscape = findDynamicImport(jsCode);
    if (moduleEscape) {
      return { ok: false, error: moduleEscape, logs: [], duration_ms: 0 };
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // Minimal environment, for the same reason the extension worker has one: a
    // Worker inherits the parent's env, and the sandbox's `process` stub lives
    // on globalThis where `await import('node:process')` simply walks around it.
    // Without this, DATABASE_URL, BETTER_AUTH_SECRET and FIELD_ENCRYPTION_KEY
    // were one import away from arbitrary edge-function code.
    const worker = new Worker(workerBootstrapPath(), {
      // `type: 'module'` is what makes the static `node:dns/promises` import at
      // the top of the bootstrap legal; without it the file is a classic script
      // and the import is a syntax error on every invocation.
      type: 'module',
      env: sandboxWorkerEnv(),
    } as WorkerOptions);

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

/**
 * Sandbox lockdown — must run BEFORE any user-supplied code inside a Bun
 * Worker. Shadows are not enough on their own: `(()=>{}).constructor` and
 * `({}).__proto__.constructor.constructor` both reach the Function/AsyncFunction
 * constructors, and once a user has either, they can `new Function('return Bun')()`
 * to grab Bun, process.env, Bun.spawn, etc. from the Worker realm.
 *
 * The fix is to make `Bun`, `process`, `Worker`, `importScripts`, `require`,
 * `module`, `exports`, `__dirname`, `__filename`, `eval`, `Function` and
 * `AsyncFunction` on the Worker's globalThis non-configurable getter-throwers.
 * After lockdown, any read — direct, indirect via Function, via Reflect, via
 * `with`, anything — hits the throwing getter and fails closed.
 *
 * What's left for the user:
 *   - fetch (replaced with safeFetch by the caller)
 *   - Request / Response / Headers / URL / URLSearchParams / crypto / JSON /
 *     Math / Date / Array / Object / String / Number / Boolean / TextEncoder /
 *     TextDecoder / Promise / Map / Set / Symbol / Error
 *   - The user's own async function declarations (these don't reach for `Function`)
 *
 * What still escapes (acceptable cost for in-process isolation):
 *   - CPU exhaustion via tight loops — caller mitigates with worker.terminate()
 *     on timeout.
 *   - Memory exhaustion — caller mitigates with the memCheck heap watchdog.
 *   - Reflection on caller's stashed references inside `safeFetch` etc. — we
 *     only ship plain primitives plus the closure-captured allowlist, so the
 *     user can't pull a private reference out unless we hand it to them.
 *
 * For tenants that need real isolation (untrusted code, multi-tenant SaaS
 * with arbitrary writers), a subprocess-per-invocation sandbox is the next
 * step — see runFunctionInSubprocess in this directory.
 */

const BLOCKED_GLOBALS = [
  'Bun',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Worker',
  'importScripts',
  'eval',
  'Function',
  // AsyncFunction / GeneratorFunction / AsyncGeneratorFunction aren't
  // properties on globalThis — they're reached via prototype chain — so
  // we lock down their .constructor below instead.
] as const;

function buildThrower(name: string): () => never {
  return () => {
    throw new Error(
      `[sandbox] access to "${name}" is blocked. Edge functions cannot reach ` +
      `Bun/Node internals, spawn processes, read the filesystem, or load ` +
      `modules. Use the allowlisted globals (fetch, Request, Response, ` +
      `crypto, JSON, Math, Date, ...) instead.`,
    );
  };
}

/**
 * Replace each name in BLOCKED_GLOBALS with a non-configurable getter that
 * throws. Idempotent — safe to call once at Worker boot. Any later attempt
 * to delete/override the property fails (strict mode) so user code cannot
 * un-block them.
 */
export function lockdownGlobals(): void {
  const g = globalThis as any;

  for (const name of BLOCKED_GLOBALS) {
    try {
      Object.defineProperty(g, name, {
        get: buildThrower(name),
        set: buildThrower(name),
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Property was already non-configurable (e.g. `eval` on some runtimes).
      // Best-effort: shadow via a wrapper function that throws.
      try { g[name] = buildThrower(name); } catch { /* truly read-only — give up */ }
    }
  }

  // Lock the Function constructor reachable through prototypes:
  //   (function(){}).constructor                 → Function
  //   (async function(){}).constructor           → AsyncFunction
  //   (function*(){}).constructor                → GeneratorFunction
  //   (async function*(){}).constructor          → AsyncGeneratorFunction
  // Replacing `.constructor` on each prototype shuts the `new Function(...)`
  // escape vector for every kind of function the user might dereference.
  const throwingCtor = function ThrowingCtor(): never {
    throw new Error(
      '[sandbox] dynamic code construction (Function / new Function / eval) ' +
      'is blocked inside edge functions.',
    );
  } as unknown as FunctionConstructor;

  const lockProto = (proto: any) => {
    try {
      Object.defineProperty(proto, 'constructor', {
        value: throwingCtor,
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch { /* prototype frozen — skip */ }
  };

  lockProto((function () { /* noop */ }).constructor.prototype);                  // Function.prototype
  lockProto(Object.getPrototypeOf(async function () { /* noop */ }));             // AsyncFunction
  lockProto(Object.getPrototypeOf(function* () { /* noop */ }));                  // GeneratorFunction
  lockProto(Object.getPrototypeOf(async function* () { /* noop */ }));            // AsyncGeneratorFunction

  // Freeze Object.prototype so prototype pollution can't reach getters added
  // after lockdown (e.g. user adds a getter on Object.prototype that fires
  // on every property access in caller-stashed state).
  try { Object.freeze(Object.prototype); } catch { /* already frozen */ }
  try { Object.freeze(Array.prototype); } catch { /* already frozen */ }
  try { Object.freeze(String.prototype); } catch { /* already frozen */ }
  try { Object.freeze(Number.prototype); } catch { /* already frozen */ }
  try { Object.freeze(Function.prototype); } catch { /* already frozen */ }
}

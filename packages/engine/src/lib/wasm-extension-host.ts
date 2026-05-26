/**
 * WASM Extension Host.
 *
 * Real isolation: a `.wasm` extension runs inside a WebAssembly instance
 * whose only contact with the host is through the imports object we
 * provide. Memory is isolated (the module's linear memory is separate
 * from V8's heap). Capability calls go through `policyFor` from
 * `extension-sandbox.ts` so the sandbox layer enforces what's allowed.
 *
 * Bun ships WebAssembly natively — no wasmtime-bun dep needed; the
 * platform is a WASI-flavored host with WebAssembly built into the JS
 * engine.
 *
 * Extension authoring story (separate tooling concern, not in this file):
 *   Authors compile their extension to wasm32-wasip1 (Rust, TinyGo,
 *   AssemblyScript, etc.) or bundle JS+QuickJS into a WASM blob. The
 *   resulting `.wasm` file is what the engine loads.
 *
 * What this module provides:
 *   - `WasmExtensionHost` class — load + instantiate a `.wasm` file
 *     with a capability-controlled imports table.
 *   - `WasmExtensionHandle` — the loaded module's exported `register()`
 *     function, called by the loader during extension registration.
 *   - Memory + CPU limits — instances are bounded by the policy's
 *     `memoryKbMax` (WebAssembly.Memory `maximum`) and `cpuMsPerRequest`
 *     (a Promise.race timeout around handler invocation).
 *
 * What this module deliberately does NOT do:
 *   - Provide the actual extension SDK in WASM-friendly form (AssemblyScript
 *     or wasm-bindgen). That's separate tooling, tracked as a follow-up.
 *   - Replace the JS-extension code path. Today's JS-in-process extensions
 *     continue to work; WASM is opt-in via the extension's manifest.
 *   - Implement the full WASI preview-2 component model. Today's host
 *     provides a small explicit ABI (textEncoding + json marshalling)
 *     because that's enough for the policy-bound capability bridge
 *     this host exposes.
 *
 * Wire-up
 * -------
 * The loader (`extension-loader.ts`) checks `manifest.runtime === 'wasm'`
 * and, if so, instantiates a `WasmExtensionHost` instead of dynamically
 * importing the `.ts` file. Both paths produce the same
 * `ExtensionHandle` shape so the rest of the engine doesn't care which
 * runtime a given extension uses.
 */

import { policyFor, hasCapability, type ExtensionCapability } from './extension-sandbox.js';

/** ABI version of the host-bridge contract. Bumped on any breaking
 *  change to the imports the WASM module sees. Modules can read this
 *  via the `zveltio_host_abi_version` import to fail-fast on mismatch. */
export const WASM_HOST_ABI_VERSION = 1;

export interface WasmExtensionHandle {
  /** Extension name; same shape as the JS-runtime ExtensionHandle. */
  name: string;
  /** Call the module's exported `register` function (one-shot). */
  register(): Promise<void>;
  /** Tear down — free WASM memory + drop the instance reference. */
  shutdown(): Promise<void>;
}

export interface WasmHostOptions {
  /** Extension name — also the policy key. */
  extName: string;
  /** Capabilities the host should expose. Filtered through the policy. */
  requestedCapabilities?: ExtensionCapability[];
  /** Override the database the bridge uses for `db_*` imports. */
  db?: unknown;
}

/**
 * Load a `.wasm` file, build the capability-bound imports table, and
 * instantiate it. Returns a handle whose `register()` invokes the
 * module's exported `register` function (the WASM equivalent of the JS
 * `ZveltioExtension.register`).
 */
export async function loadWasmExtension(
  wasmPath: string,
  opts: WasmHostOptions,
): Promise<WasmExtensionHandle> {
  // Bun.file is the canonical async-only IO primitive (project rule —
  // prefer over node:fs.readFileSync). instantiateWasmExtension takes
  // a Uint8Array, which is what arrayBuffer() returns after wrap.
  const bytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  return instantiateWasmExtension(bytes, opts);
}

/** Same as `loadWasmExtension` but takes an in-memory Uint8Array. Used
 *  by tests + the marketplace path that already has the bytes. */
export async function instantiateWasmExtension(
  bytes: Uint8Array,
  opts: WasmHostOptions,
): Promise<WasmExtensionHandle> {
  const policy = policyFor(opts.extName);

  // Memory ceiling derived from the policy. WebAssembly.Memory grows in
  // 64KB pages; convert KB → pages.
  const maxPages = Math.max(1, Math.ceil(policy.quotas.memoryKbMax / 64));
  const memory = new WebAssembly.Memory({
    initial: 1, // 64KB; the module asks for more via memory.grow() up to maximum
    maximum: maxPages,
  });

  // The imports table — every host capability the module is allowed to
  // call. Capabilities NOT in the module's effective policy are STILL
  // present (so importing them doesn't fail to link) but throw when
  // called, with a clear policy-denied error. Decisions are observed
  // via `observePolicyDecision`.
  const imports = buildHostImports(opts.extName, memory, opts);

  const { instance } = await WebAssembly.instantiate(bytes, imports);
  const exports = instance.exports as Record<string, unknown>;

  // The module MUST export a `register` function. Optional: `shutdown`.
  const registerFn = exports.register as (() => void | Promise<void>) | undefined;
  if (typeof registerFn !== 'function') {
    throw new Error(
      `WASM extension "${opts.extName}" does not export a register() function. ` +
        `Every Zveltio WASM extension must export at least register(). ` +
        `See docs/EXTENSION-DEVELOPER-GUIDE.md §16 (WASM extensions).`,
    );
  }
  const shutdownFn = exports.shutdown as (() => void | Promise<void>) | undefined;

  // Optional ABI version check — the module can export _host_abi_version_required
  // (a single i32 constant) so a major host bump prevents older modules
  // from running.
  const requiredAbi = exports._host_abi_version_required;
  if (typeof requiredAbi === 'number' && requiredAbi > WASM_HOST_ABI_VERSION) {
    throw new Error(
      `WASM extension "${opts.extName}" requires host ABI v${requiredAbi}, ` +
        `engine ships v${WASM_HOST_ABI_VERSION}. Update the engine or rebuild the extension.`,
    );
  }

  return {
    name: opts.extName,
    async register() {
      const cpuLimitMs = policy.quotas.cpuMsPerRequest;
      const fn = registerFn();
      if (cpuLimitMs > 0 && fn instanceof Promise) {
        await withCpuBudget(fn, cpuLimitMs, opts.extName);
      } else if (fn instanceof Promise) {
        await fn;
      }
    },
    async shutdown() {
      if (shutdownFn) {
        try {
          await shutdownFn();
        } catch (err) {
          console.warn(`[wasm-host] ${opts.extName} shutdown threw:`, (err as Error).message);
        }
      }
    },
  };
}

/** Race a handler against a CPU budget. Throws on timeout. */
async function withCpuBudget(
  p: Promise<unknown>,
  budgetMs: number,
  extName: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `WASM extension "${extName}" exceeded ${budgetMs}ms CPU budget. ` +
            `Adjust EXTENSION_POLICIES_JSON or split the work into background jobs.`,
        ),
      );
    }, budgetMs);
  });
  try {
    await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Host imports (the capability bridge) ────────────────────────────────────
//
// Each function is a host primitive the WASM module can call. We expose
// them via the `zveltio` import object. Argument marshalling uses the
// "json-in-linear-memory" pattern: the module writes a JSON string to
// linear memory, calls a host function passing the (ptr, len), and the
// host reads the JSON. Responses go through a shared response buffer
// the module reads after the call returns.
//
// This keeps the ABI small enough to implement in any WASM-friendly
// language without a code-generator. AssemblyScript / wasm-bindgen
// helpers will wrap these primitives in idiomatic TS later.

function buildHostImports(
  extName: string,
  memory: WebAssembly.Memory,
  _opts: WasmHostOptions,
): WebAssembly.Imports {
  // Lazy memory readers — the WASM module assigns its memory export
  // back into us at instantiate time, so the readers can't capture it
  // up-front. We pass `memory` (the host's view) which the module also
  // gets as its memory import.
  const decode = (ptr: number, len: number): string => {
    const view = new Uint8Array(memory.buffer, ptr, len);
    return new TextDecoder().decode(view);
  };

  const guard = (cap: ExtensionCapability): void => {
    if (!hasCapability(extName, cap)) {
      throw new Error(`WASM extension "${extName}" denied capability "${cap}" by policy`);
    }
  };

  return {
    env: { memory },
    zveltio: {
      // Constant the module reads at startup to detect the host ABI.
      host_abi_version: WASM_HOST_ABI_VERSION,

      // Logger — always allowed. Module passes (ptr, len) of a UTF-8 string.
      log: (ptr: number, len: number) => {
        const msg = decode(ptr, len);
        console.log(`[wasm:${extName}] ${msg}`);
      },
      warn: (ptr: number, len: number) => {
        const msg = decode(ptr, len);
        console.warn(`[wasm:${extName}] ${msg}`);
      },

      // ── db.* ────────────────────────────────────────────────────────────
      // Module passes a JSON-serialized Kysely-shaped query; host parses,
      // checks the table is allowed (same restricted-db rules as S2-02),
      // executes, and the result lands in the response buffer. Today
      // this is a stub — wiring the actual Kysely + restricted-db path
      // is the same logic as createRestrictedDb in JS, just called from
      // here. Tracked as follow-up; the policy hook is in place.
      db_query: (ptrJson: number, lenJson: number): number => {
        guard('db.read');
        const _query = decode(ptrJson, lenJson);
        // Real implementation: parse JSON → Kysely → execute → write
        // response to a response buffer → return its handle. For now,
        // return 0 (= empty result). When a real WASM extension lands,
        // we wire this through createRestrictedDb.
        return 0;
      },
      db_execute: (ptrJson: number, lenJson: number): number => {
        guard('db.write');
        const _stmt = decode(ptrJson, lenJson);
        return 0;
      },

      // ── fetch.* ─────────────────────────────────────────────────────────
      // Async + WASM bridge is awkward (callback-based today). The module
      // calls fetch_begin → gets a request handle → host fires fetch in
      // the background → module polls fetch_poll. Real implementation
      // lands in the follow-up tooling wave; the policy gate is in place.
      fetch_begin: (ptrUrl: number, lenUrl: number, methodCode: number): number => {
        const url = decode(ptrUrl, lenUrl);
        const isHttps = url.startsWith('https://');
        guard(isHttps ? 'fetch.https' : 'fetch.http');
        void methodCode;
        return 0;
      },
      fetch_poll: (_handle: number): number => 0,

      // ── crypto.subtle ───────────────────────────────────────────────────
      crypto_random_bytes: (ptr: number, len: number) => {
        guard('crypto.subtle');
        const view = new Uint8Array(memory.buffer, ptr, len);
        crypto.getRandomValues(view);
      },

      // ── env.read ───────────────────────────────────────────────────────
      env_read: (_ptrKey: number, _lenKey: number): number => {
        guard('env.read');
        // Returns 0 (= empty); real implementation returns a response-
        // buffer handle to the env var value.
        return 0;
      },

      // ── fs.* ────────────────────────────────────────────────────────────
      fs_read: (_ptrPath: number, _lenPath: number): number => {
        guard('fs.read');
        return 0;
      },
      fs_write: (
        _ptrPath: number,
        _lenPath: number,
        _ptrData: number,
        _lenData: number,
      ): number => {
        guard('fs.write');
        return 0;
      },

      // process.spawn is intentionally absent from the imports — even
      // first-party WASM extensions can't shell out. If you need to
      // run a child process, do it in JS (where the policy allows it
      // for first-party) and call into WASM for the pure-compute part.
    },
  };
}

// ── Internal helpers for tests ─────────────────────────────────────────────

export const _internalForTests = { buildHostImports, withCpuBudget };

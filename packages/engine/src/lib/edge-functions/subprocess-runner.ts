/// <reference types="bun-types" />

/**
 * Subprocess-per-invocation edge function runner.
 *
 * For UNTRUSTED multi-tenant code, run the user handler in a separate Bun
 * process (not a Worker thread) so OS-level isolation backs up the JS-level
 * lockdown. Bun's process startup is fast enough (~30ms) that this is
 * usable per-request when the function is rare; for hot paths the operator
 * should stay on the Worker runner.
 *
 * Why subprocess over Worker for untrusted code:
 *   - A Worker shares the parent process's memory space; a JIT/engine bug
 *     in V8/JSCore that escapes the JS sandbox compromises the *engine*.
 *   - A subprocess gets a fresh address space, kernel-enforced isolation,
 *     and can be hard-killed via SIGKILL (Worker.terminate is best-effort).
 *   - Bun.spawn lets us set `stdio: ['pipe', 'pipe', 'pipe']` so the
 *     subprocess can't read the parent's stdin and we capture stdout/stderr
 *     deterministically.
 *
 * Threat model still covered by the JS lockdown inside the subprocess:
 *   - The user can't reach Bun/process/eval/Function inside the spawned
 *     interpreter for the same reason as the Worker — the bootstrap calls
 *     lockdownGlobals() before invoking user code.
 * OS-level threats the subprocess additionally mitigates:
 *   - Memory exhaustion: parent can set a wall-clock kill timer and the OS
 *     reaps the child's heap on exit (Worker's heap stays attached).
 *   - Native FFI / unsafe APIs: a Bun engine bug that yields native code
 *     execution only affects the child PID.
 *
 * IPC protocol: parent writes a single JSON line on the child's stdin with
 * `{ code, request, env, timeoutMs }`; child writes a single JSON line on
 * stdout with `{ ok, response | error, logs }` and exits. Anything else on
 * stdout/stderr is captured as log lines.
 */

import { spawn } from 'bun';
import { findDynamicImport } from './no-dynamic-import.js';
import { buildSandboxSsrfGuardSource } from '../security/index.js';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EdgeRequest, EdgeResponse, RunResult } from '../edge-function-runner.js';

// Max user-supplied code size handed to a subprocess. 1 MiB is generous
// for an edge function but caps memory spikes on the parent if a route
// were tricked into spawning with attacker-sized input. Routes also
// validate at zod level; this is the second line of defence.
const MAX_CODE_BYTES = 1024 * 1024;

const SUBPROCESS_BOOTSTRAP = String.raw`
'use strict';

// Static ESM import — evaluated at module load, BEFORE lockdownGlobals() runs
// and before any user code exists, so the sandbox's own DNS check keeps working
// even though 'require'/'process' are blocked for the untrusted body below.
import { lookup as _dnsLookupImpl } from 'node:dns/promises';

const BLOCKED = ['Bun','process','require','module','exports','__dirname','__filename','Worker','importScripts','eval','Function'];

function buildThrower(name) {
  return () => { throw new Error('[sandbox] access to "' + name + '" is blocked'); };
}

function lockdownGlobals(stashed) {
  for (const name of BLOCKED) {
    try {
      Object.defineProperty(globalThis, name, {
        get: buildThrower(name),
        set: buildThrower(name),
        configurable: false,
        enumerable: false,
      });
    } catch (_) {
      try { globalThis[name] = buildThrower(name); } catch (_) {}
    }
  }
  const throwingCtor = function() { throw new Error('[sandbox] dynamic code construction is blocked'); };
  function lockProto(proto) {
    try {
      Object.defineProperty(proto, 'constructor', {
        value: throwingCtor, configurable: false, writable: false, enumerable: false,
      });
    } catch (_) {}
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

// ── SSRF guard ──────────────────────────────────────────────────────────────
// Generated from security/url-validator.ts rather than copied. A subprocess
// .mjs cannot import that module, so the guard has to exist inside this string
// — and when it was a hand-written copy under a "keep in sync" comment, it did
// not stay in sync: 192.0.0.192 (Oracle Cloud metadata) and 100.64.0.0/10 were
// added to the real blocklist and never reached the copy. Measured, not read:
// the subprocess fetched both while assertPublicUrl refused them.
//
// _dnsLookupImpl is the static import at the top of this bootstrap, evaluated
// before lockdownGlobals() runs, so the DNS-aware half keeps working for code
// that is no longer allowed to reach 'require' or 'process'.
${buildSandboxSsrfGuardSource('_dnsLookupImpl')}

(async () => {
  // Read a single line of JSON from stdin (the parent sends one envelope)
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const nl = buf.indexOf('\n');
    if (nl !== -1) { buf = buf.slice(0, nl); break; }
  }

  let envelope;
  try {
    envelope = JSON.parse(buf);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Bad envelope: ' + err.message, logs: [] }) + '\n');
    process.exit(2);
  }

  const { code, request, env, timeoutMs } = envelope;
  const logs = [];
  const _console = {
    log:   (...a) => logs.push(a.map(String).join(' ')),
    error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
    warn:  (...a) => logs.push('[warn] '  + a.map(String).join(' ')),
    info:  (...a) => logs.push('[info] '  + a.map(String).join(' ')),
  };

  // Stash the result-channel BEFORE the try/lockdown — lockdownGlobals() (run
  // inside the try) makes process throw, but BOTH the success and catch arms
  // still need process.stdout/exit to send the response envelope to the parent.
  // Declared out here so the catch block can see them (const is block-scoped).
  const _procWrite = process.stdout.write.bind(process.stdout);
  const _procExit = process.exit.bind(process);

  try {
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const _fetch = fetch;
    // Wrap fetch so untrusted user code cannot reach internal/private addresses
    // (SSRF). Validates the target + re-validates every redirect hop.
    async function safeFetch(input, init, _hops) {
      _hops = _hops || 0;
      let _url;
      if (typeof input === 'string') _url = input;
      else if (input && typeof input === 'object' && input.url) _url = input.url;
      else _url = String(input);
      await _assertUrl(_url);
      if (_hops > 5) throw new Error('[sandbox] Too many redirects.');
      const _res = await _fetch(input, Object.assign({}, init || {}, { redirect: 'manual' }));
      if (_res.status >= 300 && _res.status < 400) {
        const _loc = _res.headers.get('location');
        if (!_loc) throw new Error('[sandbox] Redirect with no Location header blocked.');
        return safeFetch(new URL(_loc, _url).toString(), init, _hops + 1);
      }
      return _res;
    }
    lockdownGlobals();

    // 'eval' is intentionally absent from this shadow-parameter list: it is an
    // illegal strict-mode parameter name, and the body below is '"use strict"',
    // so including it made the AsyncFunction constructor throw for EVERY
    // subprocess invocation. lockdownGlobals() above already blocks eval via a
    // throwing globalThis getter.
    const userFn = new AsyncFn(
      'request','env','console','fetch',
      'process','Bun','require','module','exports','globalThis','Function','Worker','importScripts','self',
      '"use strict";\n' + code +
      '\nif (typeof handler !== "function") throw new Error("Edge function must define: async function handler(request, env)");' +
      '\nreturn handler(request, env);'
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
    _procWrite(JSON.stringify({ ok: true, response, logs }) + '\n');
    _procExit(0);
  } catch (err) {
    _procWrite(JSON.stringify({ ok: false, error: err.message, logs }) + '\n');
    _procExit(1);
  }
})();
`;

/**
 * The generated bootstrap source, exposed so a test can assert that every
 * pattern in the validator's blocklist is present in it. Nothing outside tests
 * should read this.
 */
export const __subprocessBootstrapForTests = SUBPROCESS_BOOTSTRAP;

// Stash the bootstrap in a fresh PRIVATE temp dir created with
// `mkdtemp` (mode 0700, name suffixed with a random component the
// caller can't predict). Writing the bootstrap to a guessable
// `${TMPDIR}/zveltio-edge-runner-${pid}.mjs` would be a classic
// TOCTOU symlink target — an attacker with /tmp write access could
// pre-place a symlink there before the engine boots and redirect the
// write to e.g. ~root/.ssh/authorized_keys. `mkdtemp` returns a path
// that didn't exist a moment ago and is owned by the engine user, so
// the symlink window is closed before we write into it.
const bootstrapPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-edge-'));
  const file = join(dir, 'runner.mjs');
  writeFileSync(file, SUBPROCESS_BOOTSTRAP, { encoding: 'utf-8' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows lacks POSIX mode; ACL is governed by the parent dir
    // which mkdtemp already created with restrictive permissions.
  }
  return file;
})();

// Absolute path to THIS Bun binary. Avoids spawning whatever `bun`
// the child's $PATH resolves to — an attacker with write access to
// any earlier PATH entry could otherwise replace `bun` and run code
// inside the engine's user context every time an edge function fires.
const BUN_BIN = process.execPath;

/**
 * The address-space cap for one invocation, in MiB. `0` disables it.
 *
 * A per-invocation memory limit was listed as impossible here, on the grounds
 * that Bun exposes no per-worker heap cap. That is true of a Worker — Bun
 * ignores `node:worker_threads` `resourceLimits`, measured: a worker given
 * `maxOldGenerationSizeMb: 64` allocated 4 GB and reported success. It is NOT
 * true of a subprocess, which is the runner this module is and the default the
 * route uses. The kernel caps a process whatever the runtime thinks.
 *
 * Measured on this machine: under `ulimit -v`, a child that allocates without
 * bound gets a catchable "Out of memory" and the process survives to report it,
 * which is the failure we want. Below about 1 GiB of address space Bun does not
 * start at all — it exits silently before running a line — so 1024 is the floor
 * and the default, not a tuned number. RLIMIT_AS bounds virtual address space,
 * not live heap, so this is a ceiling against a runaway, not a quota.
 */
const MEMORY_LIMIT_MB = (() => {
  const raw = process.env.EDGE_MEMORY_LIMIT_MB;
  if (raw === undefined) return 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1024;
  // Anything under the floor would mean every invocation dies before it runs,
  // which reads exactly like a broken sandbox. Refuse to configure that.
  if (parsed > 0 && parsed < 1024) return 1024;
  return parsed;
})();

/**
 * Processor seconds for one invocation. `0` disables it.
 *
 * The wall clock cannot do this job on its own. It counts time spent waiting on
 * a slow HTTP call exactly like time spent spinning, so it has to be generous
 * enough for the first — which leaves the second free to burn a core for the
 * whole budget and be recorded as a normal slow run. RLIMIT_CPU counts
 * processor time only, so the two limits can each be set for what they are for.
 *
 * Ten seconds is generous for glue code and still an order of magnitude below a
 * default 30s wall clock. Supabase uses two.
 */
const CPU_LIMIT_S = (() => {
  const raw = process.env.EDGE_CPU_LIMIT_S;
  if (raw === undefined) return 10;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 10;
  return parsed;
})();

/**
 * The command to spawn, with the ceilings the platform can enforce.
 *
 * `Bun.spawn` cannot call `setrlimit`, so the limits are set by the one process
 * that can: a shell, which applies them to itself and then `exec`s the
 * interpreter, so no extra process survives. `ulimit` failing is not fatal —
 * macOS does not enforce RLIMIT_AS, and a container may already be capped
 * lower — so the shell keeps going and the invocation runs with whatever
 * ceilings the platform gave it rather than not at all.
 *
 * Both paths are engine-generated (`process.execPath`, a `mkdtemp` directory),
 * never caller input. They are single-quoted anyway, and a path containing a
 * single quote skips the shell entirely rather than being escaped cleverly.
 */
function limitedCmd(): string[] {
  const direct = [BUN_BIN, 'run', bootstrapPath];
  if (MEMORY_LIMIT_MB === 0 && CPU_LIMIT_S === 0) return direct;
  if (BUN_BIN.includes("'") || bootstrapPath.includes("'")) return direct;
  const ulimits: string[] = [];
  if (MEMORY_LIMIT_MB > 0) ulimits.push(`ulimit -v ${MEMORY_LIMIT_MB * 1024} 2>/dev/null`);
  if (CPU_LIMIT_S > 0) ulimits.push(`ulimit -t ${CPU_LIMIT_S} 2>/dev/null`);
  return ['/bin/sh', '-c', `${ulimits.join('; ')}; exec '${BUN_BIN}' run '${bootstrapPath}'`];
}

/**
 * Why the child died, when it died without answering.
 *
 * `Subprocess exited with code null` was the whole message, and `null` is what
 * an exit code is when a process was killed by a signal rather than exiting —
 * so the one case that most needs naming was the one that named nothing.
 *
 * The signal alone does not say which ceiling was hit. RLIMIT_CPU raises
 * SIGXCPU at the soft limit, but Bun does not die of it, so the kernel's
 * SIGKILL at the hard limit is what we observe — the same signal an OOM kill
 * sends. What separates them is the CPU the child actually consumed, which
 * `resourceUsage()` reports after exit. Measured: a CPU-exhausted child comes
 * back with cpu=1.00s against a 1s limit; a memory-exhausted one with cpu=0.20s
 * and a clean exit code 1.
 */
function deathCause(
  signal: string | null,
  exitCode: number | null,
  timedOut: boolean,
  cpuSeconds: number | null,
): string {
  if (
    CPU_LIMIT_S > 0 &&
    cpuSeconds !== null &&
    // Within a tick of the ceiling: the kernel stops the process AT its budget,
    // so anything that close spent its whole allowance computing.
    cpuSeconds >= CPU_LIMIT_S - 0.1
  ) {
    return `Exceeded the CPU limit of ${CPU_LIMIT_S}s (EDGE_CPU_LIMIT_S) — used ${cpuSeconds.toFixed(2)}s`;
  }
  if (timedOut) return 'Killed after the wall-clock timeout';
  if (signal === 'SIGKILL') {
    // Our timer and the CPU ceiling are both ruled out above, so this is the
    // kernel for another reason: an OOM kill, or a ceiling outside the engine
    // such as a container's.
    return 'Killed by SIGKILL — out of memory, or a ceiling outside the engine';
  }
  if (signal) return `Killed by signal ${signal}`;
  return `Subprocess exited with code ${exitCode}`;
}

/** Processor seconds the child consumed, or null when the runtime withholds it. */
function cpuSecondsOf(proc: { resourceUsage?: () => unknown }): number | null {
  try {
    const usage = proc.resourceUsage?.() as
      | { cpuTime?: { user?: bigint | number; system?: bigint | number } }
      | undefined;
    if (!usage?.cpuTime) return null;
    const micros = Number(usage.cpuTime.user ?? 0) + Number(usage.cpuTime.system ?? 0);
    return Number.isFinite(micros) ? micros / 1_000_000 : null;
  } catch {
    return null;
  }
}

export async function runEdgeFunctionInSubprocess(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  const start = Date.now();

  if (code.length > MAX_CODE_BYTES) {
    return {
      ok: false,
      error: `Code exceeds ${MAX_CODE_BYTES} byte limit (got ${code.length})`,
      logs: [],
      duration_ms: Date.now() - start,
    };
  }

  // Transpile TypeScript → JavaScript here (parent), so the subprocess
  // only runs already-transpiled JS and we don't pay the transpiler cost
  // per spawn.
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

  const proc = spawn({
    // BUN_BIN is the absolute path to the parent's own interpreter
    // (process.execPath) — never `'bun'`, which would resolve via the
    // child's PATH and could be hijacked by a same-host attacker.
    cmd: limitedCmd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // Hand the child a MINIMAL env. Inheriting the parent's env would
      // leak DATABASE_URL, BETTER_AUTH_SECRET, FIELD_ENCRYPTION_KEY, …
      // into the untrusted process — explicit allowlist instead.
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
    },
  });

  // Write the envelope to stdin, then close.
  const envelope = JSON.stringify({ code: jsCode, request, env: envVars, timeoutMs }) + '\n';
  proc.stdin.write(envelope);
  proc.stdin.end();

  // Hard wall-clock kill: timeoutMs + 3s leeway for IPC/JSON encoding.
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, timeoutMs + 3000);

  let stdoutText = '';
  let stderrText = '';
  try {
    [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } catch (err) {
    clearTimeout(killTimer);
    return {
      ok: false,
      error: `Subprocess error: ${(err as Error).message}`,
      logs: [],
      duration_ms: Date.now() - start,
    };
  }
  clearTimeout(killTimer);

  const duration_ms = Date.now() - start;

  // The handler protocol writes EXACTLY one JSON line on stdout. Anything
  // else (`console.log` from a user that imported a polluted polyfill,
  // engine crashes, …) becomes logs. We grab the LAST JSON line as the
  // envelope so stray output before it isn't mistaken for the result.
  const lines = stdoutText.split('\n').filter((l) => l.trim().length > 0);
  let envelopeOut: {
    ok: boolean;
    response?: EdgeResponse;
    error?: string;
    logs?: string[];
  } | null = null;
  const leftover: string[] = [];
  for (const line of lines) {
    if (envelopeOut == null && line.startsWith('{')) {
      try {
        envelopeOut = JSON.parse(line);
        continue;
      } catch {
        /* not JSON, treat as log */
      }
    }
    leftover.push(line);
  }

  const stderrLines = stderrText.split('\n').filter((l) => l.trim().length > 0);
  const extraLogs = [...leftover, ...stderrLines.map((l) => `[stderr] ${l}`)];

  if (!envelopeOut) {
    return {
      ok: false,
      error:
        proc.exitCode === 0
          ? 'Subprocess returned no envelope'
          : deathCause(proc.signalCode ?? null, proc.exitCode, timedOut, cpuSecondsOf(proc)),
      logs: extraLogs,
      duration_ms,
    };
  }

  return {
    ok: envelopeOut.ok,
    response: envelopeOut.response,
    error: envelopeOut.error,
    logs: [...(envelopeOut.logs ?? []), ...extraLogs],
    duration_ms,
  };
}

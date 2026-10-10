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

import { spawn, type Subprocess } from 'bun';
import { findDynamicImport } from './no-dynamic-import.js';
// Not the security barrel: the runner imports this module, and runs with no
// node_modules on a read-only root — a barrel dependency makes Bun try to
// auto-install and die (ReadOnlyFileSystem).
import {
  buildSandboxSafeFetchSource,
  buildSandboxSsrfGuardSource,
} from '../security/url-validator.js';
import { runnerInterpreterArgs, runningAsCompiledBinary } from './runner-sentinel.js';
import {
  createEgressBridge,
  EGRESS_LIMITS,
  FETCH_LINE,
  parseEgress,
  splitFetchLines,
} from './egress.js';
import { extensionTransport } from '../worker-extension-transport.js';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
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

const BLOCKED = ['Bun','process','require','module','exports','__dirname','__filename','Worker','importScripts','eval','Function',
  // A fresh realm carries its own fetch, Bun and process; a WebSocket connects
  // where the SSRF guard would have refused.
  'ShadowRealm','WebSocket',
  // Every route back to the global object itself. Bun defines 'Bun' on it as
  // non-configurable and non-writable, so the getter above cannot replace it
  // there: the global object has to stay out of reach, under every name. An
  // event dispatched on it hands it over as event.target, so the EventTarget
  // methods and on* handlers that make it one are blocked too.
  'global','globalThis','self','window','addEventListener','removeEventListener','dispatchEvent','onmessage','onerror'];

function buildThrower(name) {
  return () => { throw new Error('[sandbox] access to "' + name + '" is blocked'); };
}

function lockdownGlobals(sandboxFetch) {
  // Bare 'fetch' is the sandboxed one, and so is anything that still reads the
  // property off the global object from inside the runtime.
  Object.defineProperty(globalThis, 'fetch', {
    value: sandboxFetch, configurable: false, writable: false, enumerable: false,
  });
  const g = globalThis;
  for (const name of BLOCKED) {
    try {
      Object.defineProperty(g, name, {
        get: buildThrower(name),
        set: buildThrower(name),
        configurable: false,
        enumerable: false,
      });
    } catch (_) {
      try { g[name] = buildThrower(name); } catch (_) {}
    }
  }
  // Called with no receiver, the EventTarget methods fall back to the global
  // object, and the event they dispatch hands it over as event.target. Measured.
  for (const m of ['addEventListener','removeEventListener','dispatchEvent']) {
    const real = EventTarget.prototype[m];
    try {
      Object.defineProperty(EventTarget.prototype, m, {
        value: function(...args) {
          if (this == null) throw new Error('[sandbox] ' + m + ' needs an event target');
          return real.apply(this, args);
        },
        configurable: false, writable: false, enumerable: false,
      });
    } catch (_) {}
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

// Initialise stdout NOW, at module load, while this runner is idle and nobody is
// waiting for it.
//
// process.stdout is lazy in Bun, and touching it the first time costs about
// 9 ms. Doing that after the envelope arrived put those 9 ms inside the request:
// measured per warm invocation, of ~14 ms total, the breakdown was
//
//   parent write -> child reads envelope    1.0 ms
//   child: first touch of process.stdout    9.1 ms
//   lockdownGlobals()                       0.5 ms
//   compile + run the handler               0.9 ms
//   child writes -> parent has the answer   3.0 ms
//
// so two thirds of a warm invocation was a lazy stream waking up. Paying it at
// module load costs a pre-spawned runner nothing — it is idle — and takes an
// invocation from 13.9 ms to 4.7 ms.
//
// Captured here for the second reason too: lockdownGlobals() makes process
// throw, and both the success and failure arms still need a way to answer.
const _procWrite = process.stdout.write.bind(process.stdout);
const _procExit = process.exit.bind(process);

// Captured before lockdown: the egress bridge below encodes bodies with them.
const _Buffer = Buffer;
const _Request = Request;
const _Response = Response;

(async () => {
  // stdin carries the envelope line, then — when the engine bridges egress —
  // one answer line per FETCH line this process wrote.
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = '';
  async function readLine() {
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return line; }
      const { value, done } = await reader.read();
      if (done) { const rest = buf; buf = ''; return rest.length ? rest : null; }
      buf += decoder.decode(value, { stream: true });
    }
  }

  let envelope;
  try {
    envelope = JSON.parse((await readLine()) ?? '');
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Bad envelope: ' + err.message, logs: [] }) + '\n');
    process.exit(2);
  }

  const { code, request, env, timeoutMs, bridge } = envelope;

  // Egress through the engine (lib/edge-functions/egress.ts): the request goes
  // out as a FETCH line, the engine checks the function's allowlist and the
  // SSRF guard and answers on stdin. This process needs no network for it.
  const _pending = new Map();
  let _nextId = 0;
  let _pumping = false;
  function _pump() {
    if (_pumping) return;
    _pumping = true;
    (async () => {
      for (;;) {
        const line = await readLine();
        if (line === null) break;
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        const settle = _pending.get(m.id);
        if (settle) { _pending.delete(m.id); settle(m); }
      }
      for (const settle of _pending.values()) settle({ ok: false, error: '[egress] channel closed' });
      _pending.clear();
    })();
  }
  async function bridgeFetch(input, init) {
    const req = new _Request(input, init);
    const body = req.method === 'GET' || req.method === 'HEAD'
      ? null : new Uint8Array(await req.arrayBuffer());
    if (body && body.byteLength > ${EGRESS_LIMITS.requestBytes}) {
      throw new TypeError('[egress] request body exceeds ${EGRESS_LIMITS.requestBytes} bytes');
    }
    const id = ++_nextId;
    const answered = new Promise((resolve) => _pending.set(id, resolve));
    _procWrite('${FETCH_LINE}' + JSON.stringify({
      id, url: req.url, method: req.method, headers: [...req.headers],
      body: body ? _Buffer.from(body).toString('base64') : null,
    }) + '\n');
    _pump();
    const aborted = new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
    const m = await Promise.race([answered, aborted]);
    if (!m.ok) throw new TypeError(m.error);
    const nullBody = m.status === 101 || m.status === 204 || m.status === 205 || m.status === 304;
    return new _Response(nullBody ? null : _Buffer.from(m.body, 'base64'), {
      status: m.status, statusText: m.statusText, headers: m.headers,
    });
  }
  const logs = [];
  const _console = {
    log:   (...a) => logs.push(a.map(String).join(' ')),
    error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
    warn:  (...a) => logs.push('[warn] '  + a.map(String).join(' ')),
    info:  (...a) => logs.push('[info] '  + a.map(String).join(' ')),
  };

  try {
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const _fetch = fetch;
    // Wrap fetch so untrusted user code cannot reach internal/private addresses
    // (SSRF): the shared sandbox safeFetch validates the target, connects to
    // the address it validated, and re-validates every redirect hop.
    ${buildSandboxSafeFetchSource()}
    const _sandboxFetch = bridge ? bridgeFetch : safeFetch;
    lockdownGlobals(_sandboxFetch);

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
      userFn(request, env, _console, _sandboxFetch,
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
/**
 * Remove the bootstrap directories that earlier runs left behind.
 *
 * `mkdtemp` is deliberate — a predictable path under /tmp is a symlink target an
 * attacker can pre-place, and this file is executed by the engine — but it makes
 * a NEW directory on every process start, and nothing removed the old ones.
 * Measured on a development machine: 1413 directories, 14 MB, the oldest from
 * the day the subprocess runner landed. On a server that is one per restart,
 * per CLI invocation, per test run — and on many hosts /tmp is RAM.
 *
 * Swept rather than reused, so the symlink window stays closed. Only our own
 * directories, and only ones untouched for a day, so a second engine on the same
 * host keeps the one it is running from.
 */
function sweepStaleBootstrapDirs(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('zveltio-edge-')) continue;
    const path = join(tmpdir(), name);
    try {
      const info = statSync(path);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) continue;
      if (info.mtimeMs > cutoff) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Someone else's, already gone, or in use. Leaving it is the safe answer.
    }
  }
}

const bootstrapPath = (() => {
  sweepStaleBootstrapDirs();
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-edge-'));
  const file = join(dir, 'runner.mjs');
  writeFileSync(file, SUBPROCESS_BOOTSTRAP, { encoding: 'utf-8' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows lacks POSIX mode; ACL is governed by the parent dir
    // which mkdtemp already created with restrictive permissions.
  }
  // And take ours with us. `exit` only fires on an orderly shutdown — a SIGKILL
  // leaves the directory behind, which is what the sweep above is for.
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* going away anyway */
    }
  });
  return file;
})();

// Absolute path to THIS interpreter. Avoids spawning whatever `bun`
// the child's $PATH resolves to — an attacker with write access to
// any earlier PATH entry could otherwise replace `bun` and run code
// inside the engine's user context every time an edge function fires.
const BUN_BIN = process.execPath;

/**
 * How to ask this interpreter to run the bootstrap.
 *
 * Running from source, `process.execPath` is `bun` and `bun run <file>` is the
 * answer. In a COMPILED BINARY it is the engine itself, so `run <file>` re-runs
 * the engine with two arguments and the bootstrap never executes. Measured in a
 * real binary before this existed: every invocation came back
 * `Killed by SIGKILL`, and since the in-process Worker mode was removed there
 * was nothing left to fall back to — edge functions did not work in any
 * container deployment, because the image ships the binary.
 *
 * The binary answers its own sentinel (see `binary-entry.ts`) and imports the
 * very same generated bootstrap from disk, so there is one implementation with
 * two ways of reaching it rather than two implementations.
 */
function interpreterArgs(): string[] {
  return runnerInterpreterArgs(runningAsCompiledBinary());
}

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
const RLIMIT_AS_FLOOR_MB = 1024;

const MEMORY_LIMIT_MB = (() => {
  const raw = process.env.EDGE_MEMORY_LIMIT_MB;
  if (raw === undefined) return 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1024;
  // Anything under the floor would mean every invocation dies before it runs,
  // which reads exactly like a broken sandbox. Refuse to configure that.
  if (parsed > 0 && parsed < RLIMIT_AS_FLOOR_MB && !cgroupLimitAvailable()) {
    return RLIMIT_AS_FLOOR_MB;
  }
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
 * Whether this host can put one invocation in its own cgroup.
 *
 * `RLIMIT_AS` bounds address space, not resident memory, and JSC reserves far
 * more of the first than it uses — so the smallest workable `ulimit -v` is about
 * 1 GiB, and below it Bun core-dumps before running a line. That is not a budget
 * anybody would choose for a flow script; it is the smallest number the
 * mechanism can express.
 *
 * cgroup v2 bounds resident memory, so 128 MB means 128 MB, and only the
 * invocation's own scope is killed. Probed once by DOING it rather than by
 * inferring it from files: a host can have cgroup2 mounted and still refuse a
 * transient scope (no systemd, no delegation, a container that owns its own
 * cgroup). The probe costs one `/bin/true` at first use and is remembered.
 */
let cgroupProbe: boolean | null = null;
export function cgroupLimitAvailable(): boolean {
  if (cgroupProbe !== null) return cgroupProbe;
  cgroupProbe = (() => {
    if (process.platform !== 'linux') return false;
    if (!Bun.which('systemd-run')) return false;
    try {
      const probe = Bun.spawnSync({
        cmd: ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=64M', '/bin/true'],
        stdout: 'ignore',
        stderr: 'ignore',
      });
      return probe.exitCode === 0;
    } catch {
      return false;
    }
  })();
  return cgroupProbe;
}

/** Warn once rather than per invocation when a budget cannot be honoured. */
let flooredWarningShown = false;

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
/** The spawn command, for tests that assert its shape. */
export function __limitedCmdForTests(memoryLimitMb: number): string[] {
  return limitedCmd(memoryLimitMb);
}

function limitedCmd(memoryLimitMb: number): string[] {
  const useCgroup = memoryLimitMb > 0 && cgroupLimitAvailable();
  const floored = Math.max(memoryLimitMb, RLIMIT_AS_FLOOR_MB);
  if (memoryLimitMb > 0 && !useCgroup && floored !== memoryLimitMb && !flooredWarningShown) {
    flooredWarningShown = true;
    console.warn(
      `[edge-functions] memory budget ${memoryLimitMb} MB raised to ${floored} MB: ` +
        'no cgroup scope on this host, and RLIMIT_AS cannot express less — Bun does ' +
        'not start in under ~1 GiB of address space.',
    );
  }
  return limitedCommand(
    [BUN_BIN, ...interpreterArgs(), bootstrapPath],
    memoryLimitMb,
    CPU_LIMIT_S,
    useCgroup,
  );
}

/**
 * `argv` under the ceilings, as a shell that sets them on itself and `exec`s it.
 * Pure, so the engine (which may have a cgroup scope) and the extension runner
 * (which never has one) build the same command.
 */
export function limitedCommand(
  argv: string[],
  memoryLimitMb: number,
  cpuLimitS: number,
  useCgroup: boolean,
): string[] {
  if (memoryLimitMb === 0 && cpuLimitS === 0) return argv;
  if (argv.some((a) => a.includes("'"))) return argv;

  // CPU stays on RLIMIT_CPU even under a cgroup: the cgroup CPU controls
  // throttle rather than stop, which is not what a runaway needs.
  const ulimits: string[] = [];
  if (cpuLimitS > 0) ulimits.push(`ulimit -t ${cpuLimitS} 2>/dev/null`);
  if (memoryLimitMb > 0 && !useCgroup) {
    ulimits.push(`ulimit -v ${Math.max(memoryLimitMb, RLIMIT_AS_FLOOR_MB) * 1024} 2>/dev/null`);
  }

  // `systemd-run` needs the session bus to create a scope, and it hands its own
  // environment to what it runs — so the two variables that let it work would
  // land in the sandbox. The inner shell drops them before `exec`, which keeps
  // the child's environment exactly as minimal as it is without a cgroup.
  const prelude = useCgroup ? 'unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; ' : '';
  const [bin, ...rest] = argv;
  const inner = `${prelude}${ulimits.join('; ')}${ulimits.length ? '; ' : ''}exec '${bin}' ${rest.map((a) => `'${a}'`).join(' ')}`;
  if (!useCgroup) return ['/bin/sh', '-c', inner];

  // MemorySwapMax=0 matters: without it the budget is memory PLUS swap, and a
  // runaway only gets slower instead of stopping.
  return [
    'systemd-run',
    '--user',
    '--scope',
    '-q',
    '-p',
    `MemoryMax=${memoryLimitMb}M`,
    '-p',
    'MemorySwapMax=0',
    '/bin/sh',
    '-c',
    inner,
  ];
}

/**
 * The environment the spawned command starts with.
 *
 * MINIMAL by construction: inheriting the parent's would put DATABASE_URL,
 * BETTER_AUTH_SECRET and FIELD_ENCRYPTION_KEY inside untrusted code, so this is
 * an explicit allowlist.
 *
 * When a cgroup scope is being created, `systemd-run` itself needs the session
 * bus, so those two variables are added HERE and removed by the inner shell
 * before the interpreter is exec'd. The sandbox sees the same minimal
 * environment either way; only systemd-run sees more.
 */
function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
  };
  if (cgroupLimitAvailable()) {
    if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    if (process.env.DBUS_SESSION_BUS_ADDRESS) {
      env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
    }
  }
  return env;
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

/**
 * Pre-spawned runners.
 *
 * A process per invocation is what makes the ceilings enforceable — the kernel
 * bounds processes, not threads — and its price is startup. Measured with this
 * bootstrap, median of 12: spawned on demand 41.6 ms, already waiting 13.4 ms.
 * The interpreter boots, evaluates this module (the DNS import, the generated
 * SSRF guard) and blocks reading stdin; when a request arrives it pays only the
 * envelope.
 *
 * What the pool does NOT change is the isolation: a runner serves exactly one
 * invocation and exits. Reuse would hand the next caller the previous one's
 * globals, which is the property this runner exists for.
 *
 * `EDGE_RUNNER_POOL` is how many to keep waiting. 0 restores spawn-on-demand
 * exactly. Each waiting runner costs about 45 MB resident, so the default is
 * deliberately small: two covers an ordinary arrival pattern, and a burst that
 * empties the pool falls back to spawning, which is the behaviour without a
 * pool rather than a failure.
 */
const POOL_SIZE = (() => {
  const raw = process.env.EDGE_RUNNER_POOL;
  if (raw === undefined) return 2;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  // A pool this large is a configuration mistake, not an intention: 16 waiting
  // runners is ~720 MB held to save 28 ms.
  return Math.min(parsed, 16);
})();

/**
 * The stdio shape is part of the type, not a detail: `ReturnType<typeof spawn>`
 * widens stdin/stdout to `number | FileSink | ReadableStream`, and the pool then
 * hands back something the caller cannot write an envelope to.
 */
type Runner = Subprocess<'pipe', 'pipe', 'pipe'>;

const idleRunners: Runner[] = [];
const servedPids: number[] = [];
let poolDraining = false;

function spawnRunner(memoryLimitMb: number): Runner {
  const runner = spawn({
    // BUN_BIN is the absolute path to the parent's own interpreter
    // (process.execPath) — never `'bun'`, which would resolve via the
    // child's PATH and could be hijacked by a same-host attacker.
    cmd: limitedCmd(memoryLimitMb),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: spawnEnv(),
  });
  // A runner that is only WAITING must not keep the process alive. Without
  // this, a process whose work is done hangs until something drains the pool —
  // measured on a compiled binary that had answered every request correctly and
  // then never exited. The engine's shutdown drains explicitly; this is for
  // everything that simply finishes.
  runner.unref();
  return runner;
}

/**
 * Take a waiting runner, or spawn one; then top the pool back up without
 * awaiting it, so the replacement boots while this request is being served.
 *
 * A runner is only pooled for the DEFAULT budget. A caller asking for a tighter
 * ceiling gets a fresh process with that ceiling — handing it a pre-spawned one
 * would silently run it under the instance default, which is the kind of
 * mismatch nobody notices until it matters.
 */
function takeRunner(memoryLimitMb: number, pooled: boolean): Runner {
  const runner = pooled ? idleRunners.shift() : undefined;
  if (pooled && !poolDraining) {
    while (idleRunners.length < POOL_SIZE) idleRunners.push(spawnRunner(memoryLimitMb));
  }
  const taken = runner ?? spawnRunner(memoryLimitMb);
  // Serving one, though, is work in flight: hold the loop open until it answers.
  taken.ref();
  if (taken.pid) servedPids.push(taken.pid);
  return taken;
}

/**
 * Kill every waiting runner. Called on shutdown; a test that spawns runners
 * must call it too, or they outlive the process that made them.
 */
export async function drainRunnerPool(): Promise<void> {
  poolDraining = true;
  const waiting = idleRunners.splice(0, idleRunners.length);
  for (const runner of waiting) {
    try {
      runner.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await Promise.all(waiting.map((r) => r.exited.catch(() => undefined)));
  poolDraining = false;
}

/** Pool state, for tests that assert replacement and single use. */
export function __poolStatsForTests(): { idle: number; servedPids: number[] } {
  return { idle: idleRunners.length, servedPids: [...servedPids] };
}

/** Where this process wrote its bootstrap, for the temp-directory tests. */
export const __bootstrapPathForTests = bootstrapPath;

export async function runEdgeFunctionInSubprocess(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
  /**
   * Per-invocation overrides. `memoryLimitMb` asks for a tighter budget than the
   * instance default — honoured exactly where a cgroup scope exists, raised to
   * the RLIMIT_AS floor with one warning where it does not. `egress` is the
   * function's `egress` column (see egress.ts); absent, it declares nothing.
   */
  opts: { memoryLimitMb?: number; egress?: readonly unknown[] | null } = {},
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

  let egress: string[] | null;
  try {
    egress = parseEgress(opts.egress);
  } catch (err) {
    return { ok: false, error: (err as Error).message, logs: [], duration_ms: 0 };
  }
  const transport = edgeTransport(egress);
  // On the runner every fetch crosses to the engine — an undeclared function's
  // is refused there, with a reason, instead of dying on a closed network. A
  // declared function is held to its list wherever it runs.
  const bridged = transport === 'runner' || egress !== null;
  if (transport === 'process' && egress === null) warnUndeclaredEgress();

  const budgetMb = opts.memoryLimitMb ?? MEMORY_LIMIT_MB;
  const envelope =
    JSON.stringify({ code: jsCode, request, env: envVars, timeoutMs, bridge: bridged }) + '\n';
  const bridge = bridged ? { list: egress ?? [], timeoutMs } : null;
  const outcome =
    transport === 'runner'
      ? await invokeOverRunner(budgetMb, envelope, timeoutMs, bridge!)
      : await invokeLocally(
          budgetMb,
          envelope,
          timeoutMs,
          opts.memoryLimitMb === undefined,
          bridge,
        );
  return toRunResult(outcome, Date.now() - start);
}

/** How the engine serves one invocation's egress: the declared hosts, and its time. */
interface BridgeSpec {
  list: string[];
  timeoutMs: number;
}

/**
 * Wire an invocation's FETCH lines to the engine's egress bridge. `kill` ends the
 * invocation; the reason it gives replaces whatever the death would have read as.
 */
function bridgeFor(
  spec: BridgeSpec | null,
  reply: (line: string) => void,
  kill: () => void,
): { onFetch: ((json: string) => void) | null; close: () => void; violation: () => string | null } {
  if (!spec) return { onFetch: null, close: () => undefined, violation: () => null };
  let violation: string | null = null;
  const b = createEgressBridge(spec.list, spec.timeoutMs, reply, (why) => {
    violation ??= why;
    kill();
  });
  return { onFetch: b.line, close: b.close, violation: () => violation };
}

let undeclaredWarningShown = false;
/**
 * Transition (RFC step 10): where third-party extensions go to the runner, an
 * edge function that declares no egress still runs as the engine's child, with
 * the engine's network — moving it would cut it off. Said once per process.
 */
function warnUndeclaredEgress(): void {
  if (undeclaredWarningShown || extensionTransport() !== 'runner') return;
  undeclaredWarningShown = true;
  console.warn(
    "[edge-functions] an edge function that declares no egress ran as the engine's child, " +
      "with the engine's network. Declare the hosts it calls in its egress field " +
      '(an empty list for none) to move it to the extension runner; ' +
      'ZVELTIO_EDGE_TRANSPORT=runner moves every function and cuts off the undeclared ones.',
  );
}

/** What one invocation left behind, wherever it ran. */
interface Outcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  cpuSeconds: number | null;
  timedOut: boolean;
  /** The invocation never produced an outcome (spawn or channel failure). */
  error?: string;
}

async function invokeLocally(
  budgetMb: number,
  envelope: string,
  timeoutMs: number,
  pooled: boolean,
  bridgeSpec: BridgeSpec | null = null,
): Promise<Outcome> {
  const proc = takeRunner(budgetMb, POOL_SIZE > 0 && pooled);
  const killProc = () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  };
  const bridge = bridgeFor(
    bridgeSpec,
    (line) => {
      try {
        proc.stdin.write(line);
        proc.stdin.flush();
      } catch {
        /* exited meanwhile */
      }
    },
    killProc,
  );

  proc.stdin.write(envelope);
  // A bridged invocation's answers follow the envelope, so its stdin stays open.
  if (bridgeSpec) proc.stdin.flush();
  else proc.stdin.end();

  // Hard wall-clock kill: timeoutMs + 3s leeway for IPC/JSON encoding.
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProc();
  }, timeoutMs + 3000);

  try {
    const [stdout, stderr] = await Promise.all([
      splitFetchLines(proc.stdout, bridge.onFetch),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const violation = bridge.violation();
    if (violation) return emptyOutcome(`Killed: ${violation}`);
    return {
      stdout,
      stderr,
      exitCode: proc.exitCode,
      signal: proc.signalCode ?? null,
      cpuSeconds: cpuSecondsOf(proc),
      timedOut,
    };
  } catch (err) {
    return emptyOutcome(`Subprocess error: ${(err as Error).message}`);
  } finally {
    clearTimeout(killTimer);
    bridge.close();
    if (bridgeSpec) {
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
    }
  }
}

function emptyOutcome(error: string): Outcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    cpuSeconds: null,
    timedOut: false,
    error,
  };
}

function toRunResult(o: Outcome, duration_ms: number): RunResult {
  if (o.error) return { ok: false, error: o.error, logs: [], duration_ms };

  // The handler protocol writes EXACTLY one JSON line on stdout. Anything
  // else (`console.log` from a user that imported a polluted polyfill,
  // engine crashes, …) becomes logs. The FIRST line that parses as JSON is
  // the envelope; anything before or after it is kept as a log line.
  const lines = o.stdout.split('\n').filter((l) => l.trim().length > 0);
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

  const stderrLines = o.stderr.split('\n').filter((l) => l.trim().length > 0);
  const extraLogs = [...leftover, ...stderrLines.map((l) => `[stderr] ${l}`)];

  if (!envelopeOut) {
    return {
      ok: false,
      error:
        o.exitCode === 0
          ? 'Subprocess returned no envelope'
          : deathCause(o.signal, o.exitCode, o.timedOut, o.cpuSeconds),
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

// ── The runner placement (RFC extension-runner, step 5) ─────────────────────
//
// `ZVELTIO_EDGE_TRANSPORT=runner` runs each invocation in the extension runner
// (lib/ext-runner.ts) instead of as the engine's child: under a uid that cannot
// read the engine's files, environment or process state. One connection is one
// invocation. The engine writes a header line and the envelope; the runner
// spawns the same bootstrap under the same ceilings, waits for it, and answers
// one JSON line carrying what a local spawn would have observed — stdout,
// stderr, exit code, signal, CPU seconds — so the result is built by the same
// `toRunResult`. Closing the connection kills the invocation.
//
// A separate switch from ZVELTIO_EXT_TRANSPORT on purpose: `ext-runner setup`
// already sets that one on every bare-metal install, and the runner denies
// every address until the operator allows one — tying the two would cut edge
// functions off the network on the next update. Default flip is RFC step 10.

/**
 * Where one invocation runs. `ZVELTIO_EDGE_TRANSPORT` when it names a transport;
 * otherwise (RFC step 10) a function that declares its egress goes where
 * third-party extensions go — the runner in production, a local child on a
 * development machine, which has no runner — and one that declares none stays
 * the engine's child, since the runner's closed network would cut it off.
 */
export function edgeTransport(egress: string[] | null = null): 'process' | 'runner' {
  const t = process.env.ZVELTIO_EDGE_TRANSPORT;
  if (t === 'runner' || t === 'process') return t;
  return egress !== null ? extensionTransport() : 'process';
}

/**
 * The first line on an edge connection: `EDGE <memory MiB> <cpu s>`. The
 * runner tells it from an extension's channel by its first byte — a frame
 * starts with its length's top byte, at most 0x02 under the 32 MiB frame cap,
 * never `E`.
 */
export const EDGE_HEADER_TAG = 'EDGE';

export function parseEdgeHeader(line: string): { memoryMb: number; cpuS: number } | null {
  const m = /^EDGE (\d{1,7}) (\d{1,7})$/.exec(line);
  return m ? { memoryMb: Number(m[1]), cpuS: Number(m[2]) } : null;
}

async function invokeOverRunner(
  budgetMb: number,
  envelope: string,
  timeoutMs: number,
  bridge: BridgeSpec,
): Promise<Outcome> {
  const { edgeRunnerSocket, forgetEdgeRunner } = await import('../ext-runner.js');
  let socketPath: string;
  try {
    socketPath = await edgeRunnerSocket();
  } catch (err) {
    return emptyOutcome(`Edge runner unavailable: ${(err as Error).message}`);
  }
  const outcome = await exchangeWithRunner(
    socketPath,
    `${EDGE_HEADER_TAG} ${budgetMb} ${CPU_LIMIT_S}\n${envelope}`,
    timeoutMs + 3000,
    bridge,
  );
  // A runner that went away (restarted, stopped) is started again next time.
  if (outcome.error) forgetEdgeRunner();
  return outcome;
}

/**
 * One invocation over a runner socket; exported for the transport test. The
 * runner forwards the sandbox's FETCH lines as they come and ends with one
 * outcome line; the bridge's answers go back down the same socket.
 */
export function exchangeWithRunner(
  socketPath: string,
  request: string,
  killAfterMs: number,
  bridgeSpec: BridgeSpec | null = null,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    let timedOut = false;
    let failure: string | null = null;
    const bridge = bridgeFor(
      bridgeSpec,
      (line) => {
        if (!sock.destroyed) sock.write(line);
      },
      () => sock.destroy(),
    );
    // Same leeway as the local kill; closing the connection is the kill.
    const killTimer = setTimeout(() => {
      timedOut = true;
      sock.destroy();
    }, killAfterMs);
    sock.on('connect', () => sock.write(request));
    const received = splitFetchLines(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sock.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)));
          sock.on('close', () => controller.close());
        },
      }),
      bridge.onFetch,
    );
    sock.on('error', (err) => {
      failure = `Edge runner ${socketPath}: ${err.message}`;
    });
    sock.on('close', async () => {
      clearTimeout(killTimer);
      bridge.close();
      const text = await received;
      const violation = bridge.violation();
      if (violation) {
        resolve(emptyOutcome(`Killed: ${violation}`));
        return;
      }
      try {
        const r = JSON.parse(text) as Omit<Outcome, 'timedOut'>;
        resolve({ ...r, timedOut });
      } catch {
        const lost = emptyOutcome(failure ?? 'Edge runner closed the connection without a result');
        // Our own kill: report it as the local runner does, not as a lost channel.
        resolve(timedOut ? { ...lost, error: undefined, timedOut } : lost);
      }
    });
  });
}

/** The bootstrap this process wrote, for the runner to hand to its own uids. */
export const edgeBootstrapPath = bootstrapPath;

/**
 * Runner side of one edge connection (`first` holds the bytes read so far):
 * spawn the bootstrap under the requested ceilings, through `wrap` (setpriv in
 * containers), feed it the envelope, and answer with what it left behind.
 */
export function serveEdgeConnection(
  conn: Socket,
  first: Buffer,
  wrap: (argv: string[]) => { argv: string[]; release?: () => void },
): void {
  let buf = first;
  let proc: Runner | null = null;
  let done = false;
  const onData = (chunk: Buffer) => {
    if (done) return;
    if (proc) {
      // An egress answer can land after the process exited, before `done`.
      try {
        proc.stdin.write(chunk);
        proc.stdin.flush();
      } catch {
        /* exited meanwhile */
      }
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(10);
    if (nl === -1) {
      if (buf.length > 64) conn.destroy();
      return;
    }
    const header = parseEdgeHeader(buf.subarray(0, nl).toString('latin1'));
    if (!header) {
      conn.destroy();
      return;
    }
    const { argv, release } = wrap(
      limitedCommand(
        [BUN_BIN, ...interpreterArgs(), bootstrapPath],
        header.memoryMb,
        header.cpuS,
        false,
      ),
    );
    const started: Runner = spawn({
      cmd: argv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: tmpdir() },
      cwd: '/',
    });
    proc = started;
    void started.exited.then(() => release?.());
    started.stdin.write(buf.subarray(nl + 1));
    started.stdin.flush();
    void (async () => {
      const [stdout, stderr] = await Promise.all([
        // The sandbox's egress requests go to the engine as they come; the
        // runner itself has no network to serve them with.
        splitFetchLines(started.stdout, (json) => {
          if (!done) conn.write(`${FETCH_LINE}${json}\n`);
        }),
        new Response(started.stderr).text(),
      ]);
      await started.exited;
      done = true;
      conn.end(
        `${JSON.stringify({
          stdout,
          stderr,
          exitCode: started.exitCode,
          signal: started.signalCode ?? null,
          cpuSeconds: cpuSecondsOf(started),
        })}\n`,
      );
    })();
  };
  const kill = () => {
    if (done || !proc) return;
    try {
      proc.kill('SIGKILL');
    } catch (err) {
      console.error(`[ext-runner] could not kill edge pid ${proc.pid}: ${(err as Error).message}`);
    }
  };
  conn.on('close', kill);
  conn.on('error', kill);
  conn.on('data', onData);
  // The router paused the connection to read its first chunk.
  conn.resume();
  onData(Buffer.alloc(0));
}

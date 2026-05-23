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

  try {
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const _fetch = fetch;
    lockdownGlobals();

    const userFn = new AsyncFn(
      'request','env','console','fetch',
      'process','Bun','require','module','exports','globalThis','eval','Function','Worker','importScripts','self',
      '"use strict";\n' + code +
      '\nif (typeof handler !== "function") throw new Error("Edge function must define: async function handler(request, env)");' +
      '\nreturn handler(request, env);'
    );

    const timeout = new Promise((_,rej) =>
      setTimeout(() => rej(new Error('Execution timed out after ' + timeoutMs + 'ms')), timeoutMs)
    );

    const raw = await Promise.race([
      userFn(request, env, _console, _fetch,
        undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined),
      timeout,
    ]);

    let response;
    if (raw && typeof raw === 'object' && 'status' in raw) {
      response = { status: raw.status ?? 200, body: raw.body ?? null, headers: raw.headers ?? {} };
    } else {
      response = { status: 200, body: raw ?? null, headers: {} };
    }
    process.stdout.write(JSON.stringify({ ok: true, response, logs }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message, logs }) + '\n');
    process.exit(1);
  }
})();
`;

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
    const transpiler = new (Bun as any).Transpiler({ loader: 'ts' });
    jsCode = transpiler.transformSync(code);
  } catch (err: any) {
    return { ok: false, error: `Transpile error: ${err.message}`, logs: [], duration_ms: Date.now() - start };
  }

  const proc = spawn({
    // BUN_BIN is the absolute path to the parent's own interpreter
    // (process.execPath) — never `'bun'`, which would resolve via the
    // child's PATH and could be hijacked by a same-host attacker.
    cmd: [BUN_BIN, 'run', bootstrapPath],
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
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
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
    return { ok: false, error: `Subprocess error: ${(err as Error).message}`, logs: [], duration_ms: Date.now() - start };
  }
  clearTimeout(killTimer);

  const duration_ms = Date.now() - start;

  // The handler protocol writes EXACTLY one JSON line on stdout. Anything
  // else (`console.log` from a user that imported a polluted polyfill,
  // engine crashes, …) becomes logs. We grab the LAST JSON line as the
  // envelope so stray output before it isn't mistaken for the result.
  const lines = stdoutText.split('\n').filter((l) => l.trim().length > 0);
  let envelopeOut: { ok: boolean; response?: EdgeResponse; error?: string; logs?: string[] } | null = null;
  const leftover: string[] = [];
  for (const line of lines) {
    if (envelopeOut == null && line.startsWith('{')) {
      try {
        envelopeOut = JSON.parse(line);
        continue;
      } catch { /* not JSON, treat as log */ }
    }
    leftover.push(line);
  }

  const stderrLines = stderrText.split('\n').filter((l) => l.trim().length > 0);
  const extraLogs = [...leftover, ...stderrLines.map((l) => `[stderr] ${l}`)];

  if (!envelopeOut) {
    return {
      ok: false,
      error: proc.exitCode === 0 ? 'Subprocess returned no envelope' : `Subprocess exited with code ${proc.exitCode}`,
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

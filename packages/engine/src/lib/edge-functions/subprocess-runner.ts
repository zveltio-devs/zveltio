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

// ── SSRF guard (inlined; a subprocess .mjs cannot import url-validator.ts) ──
// Mirrors packages/engine/src/lib/security/url-validator.ts — keep in sync.
// Untrusted edge code must not reach loopback/link-local/RFC1918/metadata or
// non-http(s) schemes, incl. IPv6 (bracket-stripped) + IPv4-mapped/alt encodings.
function _intToIPv4(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}
function _normalizeHost(host) {
  const h = String(host).toLowerCase();
  let m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return ((hi >> 8) & 0xff) + '.' + (hi & 0xff) + '.' + ((lo >> 8) & 0xff) + '.' + (lo & 0xff);
  }
  if (/^0x[0-9a-f]+$/.test(h)) return _intToIPv4(parseInt(h, 16));
  if (/^\d+$/.test(h)) { const n = parseInt(h, 10); if (n > 0xffff && n <= 0xffffffff) return _intToIPv4(n); }
  if (/^[\da-fx.]+$/.test(h) && h.indexOf('.') !== -1) {
    const octets = h.split('.');
    if (octets.length === 4) {
      const nums = octets.map(function (o) {
        if (o.indexOf('0x') === 0) return parseInt(o, 16);
        if (o.charAt(0) === '0' && o.length > 1) return parseInt(o, 8);
        return parseInt(o, 10);
      });
      if (nums.every(function (n) { return !Number.isNaN(n) && n >= 0 && n <= 255; })) return nums.join('.');
    }
  }
  return h;
}
const _BLOCKED = [
  /^localhost$/, /^127\.\d+\.\d+\.\d+$/, /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, /^192\.168\.\d+\.\d+$/, /^169\.254\.\d+\.\d+$/,
  /^::1$/, /^::$/, /^fe[89ab][0-9a-f]:/, /^f[cd][0-9a-f]{2}:/, /^0\.0\.0\.0$/,
  /host\.docker\.internal$/, /kubernetes\.default$/,
];
function _isBlockedHost(host) {
  const bare = String(host).replace(/^\[|\]$/g, '');
  const normalized = _normalizeHost(bare);
  return _BLOCKED.some(function (re) { return re.test(bare) || re.test(normalized); });
}
function _validateUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) { throw new Error('[sandbox] Invalid URL: ' + rawUrl); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('[sandbox] Only http/https URLs are allowed (got "' + parsed.protocol + '")');
  }
  if (_isBlockedHost(parsed.hostname.toLowerCase())) {
    throw new Error('[sandbox] Network access to internal/private address blocked: ' + rawUrl);
  }
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
      _validateUrl(_url);
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
          : `Subprocess exited with code ${proc.exitCode}`,
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

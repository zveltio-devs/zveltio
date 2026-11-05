/**
 * The Deno job runner (ADR 0022): one Deno process per run, with no
 * permissions but a read of its own copy of `jobs.js`.
 *
 * Deno opens no socket, reads no environment, writes no file. Everything the
 * job reaches is a request to the engine: one JSON line per message on
 * stdin/stdout, answered by `call`, which the caller binds to the job's
 * principal, tenant and declared collections. The child supplies only the
 * arguments of a call, never who it acts as.
 *
 * Ceilings, each of which kills the child (SIGKILL) and fails the run: the
 * wall clock (`timeoutSeconds`), memory, 1,000 host calls, 16 MiB of stdout, a
 * malformed line. Memory is bounded three ways because no one way is enough:
 * `--max-old-space-size` caps the V8 heap but not ArrayBuffers; a cgroup scope
 * caps everything where one can be created; elsewhere the engine reads the
 * child's resident size from /proc and kills it past the budget. RLIMIT_AS
 * (ADR 0022 "prlimit --as") cannot be used: V8's sandbox reserves about 1 TiB
 * of address space, so Deno aborts at start under any limit below it
 * (measured 2026-11-05, Deno 2.9.8: dies at 32 GiB, starts at 1.1 TiB).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun';
import { cgroupLimitAvailable, limitedCommand } from '../edge-functions/subprocess-runner.js';

export const RUNNER_LIMITS = {
  hostCalls: 1000,
  stdoutBytes: 16 * 1024 * 1024,
  /** Deno's own resident size before a job allocates anything, added to `memoryMb`. */
  runtimeMb: 64,
  stderrTail: 2048,
  watchdogMs: 50,
};

/** The host calls a job may make; nothing else reaches the engine. */
export const HOST_CALLS = [
  'collections.read',
  'collections.list',
  'collections.insert',
  'collections.update',
  'collections.delete',
  'fetch',
] as const;
export type HostCall = (typeof HOST_CALLS)[number];

export interface RunnerRun {
  deno: string;
  /** The verified bytes of the extension's `jobs.js`. */
  code: Uint8Array;
  job: string;
  input: unknown;
  timezone: string;
  memoryMb: number;
  timeoutSeconds: number;
  /** Answers one host call; a throw is handed back to the job as its error. */
  call: (name: HostCall, args: unknown[]) => Promise<unknown>;
  /** Aborted on unload: the child is killed and the run fails. */
  signal?: AbortSignal;
}

/**
 * The child's side. Static: nothing of the run is interpolated into it; the
 * job's name, input and time zone arrive as the first stdin line.
 */
export const RUNNER_BOOTSTRAP = `
const enc = new TextEncoder();
const out = Deno.stdout.writable.getWriter();
let queue = Promise.resolve();
const send = (m) => (queue = queue.then(() => out.write(enc.encode(JSON.stringify(m) + '\\n'))));
// The channel is stdout: the job's console goes to stderr, so a log line never corrupts it.
for (const k of ['log', 'info', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed']) {
  console[k] = (...a) => console.error(...a);
}
const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pending = new Map();
let next = 0;
const call = (name, args) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    send({ id, call: name, args });
  });
const host = Object.freeze({
  collections: Object.freeze({
    read: (c, id) => call('collections.read', [c, id]),
    list: (c, q) => call('collections.list', [c, q ?? {}]),
    insert: (c, d) => call('collections.insert', [c, d]),
    update: (c, id, d, o) => call('collections.update', [c, id, d, o ?? {}]),
    delete: (c, id) => call('collections.delete', [c, id]),
  }),
  // The engine performs it (ADR 0022 decision 3): this process opens no socket.
  fetch: async (input, init) => {
    const req = new Request(input, init);
    // The engine follows redirects, each hop held to the egress list; it offers no other mode.
    if (req.redirect !== 'follow') throw new TypeError('host.fetch follows redirects only');
    const signal = init && init.signal;
    if (signal) {
      signal.throwIfAborted();
      return Promise.race([
        host.fetch(input, { ...init, signal: undefined }),
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ]);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : b64(new Uint8Array(await req.arrayBuffer()));
    const a = await call('fetch', [{ url: req.url, method: req.method, headers: [...req.headers], body }]);
    const nullBody = [101, 103, 204, 205, 304].includes(a.status);
    const res = new Response(nullBody ? null : unb64(a.body), { status: a.status, statusText: a.statusText, headers: a.headers });
    Object.defineProperty(res, 'url', { value: a.url });
    Object.defineProperty(res, 'redirected', { value: a.redirected });
    return res;
  },
});
async function run(start) {
  let done;
  try {
    const mod = await import(Deno.args[0]);
    const fn = (mod.default ?? {})[start.job];
    if (typeof fn !== 'function') throw new Error('jobs.js exports no job "' + start.job + '"');
    await fn(start.input, { ...host, timezone: start.timezone });
    done = { done: true, ok: true };
  } catch (e) {
    done = { done: true, error: String((e && e.message) || e) };
  }
  send(done);
}
let buf = '';
let started = false;
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (!started) {
      started = true;
      run(m);
      continue;
    }
    const p = pending.get(m.id);
    if (!p) continue;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, status: m.error.status }));
  }
}
// stdin closed: the engine ended the run, or died. Either way, so does this.
Deno.exit(0);
`;

/** Run one job in Deno. Resolves when it succeeded; rejects, saying why, otherwise. */
export async function runInDeno(r: RunnerRun): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'zv-job-'));
  try {
    return await runIn(dir, r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir: string, r: RunnerRun): Promise<void> {
  const jobsPath = join(dir, 'jobs.js');
  const bootPath = join(dir, 'bootstrap.js');
  writeFileSync(jobsPath, r.code);
  writeFileSync(bootPath, RUNNER_BOOTSTRAP);
  const budgetMb = r.memoryMb + RUNNER_LIMITS.runtimeMb;
  // `limitedCommand` drops every ceiling for an argument with a quote in it; refuse instead.
  if ([r.deno, dir].some((p) => p.includes("'"))) {
    return Promise.reject(new Error(`the Deno path or temp directory contains a quote: ${r.deno}`));
  }
  const useCgroup = cgroupLimitAvailable();
  const argv = [
    r.deno,
    'run',
    '--no-prompt',
    '--no-config',
    '--no-remote',
    '--no-npm',
    `--allow-read=${jobsPath}`,
    `--v8-flags=--max-old-space-size=${r.memoryMb}`,
    bootPath,
    jobsPath,
  ];
  // No RLIMIT_AS (see the header): memory goes to the cgroup when there is one, never `ulimit -v`.
  const cmd = limitedCommand(argv, useCgroup ? budgetMb : 0, r.timeoutSeconds, useCgroup);
  // Empty but for what systemd-run needs to create the scope, which the inner shell unsets.
  const env: Record<string, string> = {};
  if (useCgroup) {
    for (const k of ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  }
  const child = spawn({ cmd, cwd: dir, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });

  return new Promise<void>((resolve, reject) => {
    let failure: string | null = null;
    let outcome: { ok: true } | { error: string } | null = null;
    let ended = false;
    let calls = 0;
    let stdoutBytes = 0;
    const inFlight = new Set<Promise<void>>();
    let stderr = '';

    const kill = (why: string) => {
      failure ??= why;
      child.kill('SIGKILL');
    };
    const write = (m: unknown) => {
      if (outcome || failure) return;
      try {
        child.stdin.write(`${JSON.stringify(m)}\n`);
        child.stdin.flush();
      } catch {
        /* the child is gone; its exit settles the run */
      }
    };

    const timer = setTimeout(
      () => kill(`killed after the timeout of ${r.timeoutSeconds}s`),
      r.timeoutSeconds * 1000,
    );
    const onAbort = () => kill('the extension was unloaded while the job ran');
    r.signal?.addEventListener('abort', onAbort);
    if (r.signal?.aborted) onAbort();
    const watchdog =
      process.platform === 'linux'
        ? setInterval(() => {
            const kb = rssKb(child.pid);
            if (kb !== null && kb > budgetMb * 1024) {
              kill(`exceeded the memory limit of ${r.memoryMb} MB (memoryMb)`);
            }
          }, RUNNER_LIMITS.watchdogMs)
        : null;

    const answer = (id: number, name: HostCall, args: unknown[]) => {
      const p = r.call(name, args).then(
        (value) => write({ id, ok: true, value: value ?? null }),
        (err: { message?: string; code?: unknown; status?: unknown }) =>
          write({
            id,
            ok: false,
            error: {
              message: String(err?.message ?? err),
              code: typeof err?.code === 'string' ? err.code : undefined,
              status: typeof err?.status === 'number' ? err.status : undefined,
            },
          }),
      );
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    };

    const onLine = (line: string) => {
      // Killed: lines still buffered from the same chunk are not acted on.
      if (failure) return;
      let m: {
        id?: unknown;
        call?: unknown;
        args?: unknown;
        done?: unknown;
        ok?: unknown;
        error?: unknown;
      };
      try {
        m = JSON.parse(line);
      } catch {
        return kill('the job wrote a line that is not a message');
      }
      if (m === null || typeof m !== 'object')
        return kill('the job wrote a line that is not a message');
      if (m.done === true) {
        if (ended) return kill('the job ended twice');
        ended = true;
        const result =
          m.ok === true ? { ok: true as const } : { error: String(m.error ?? 'failed') };
        // Calls in flight finish first; one sent after `done` is refused below.
        void Promise.allSettled([...inFlight]).then(() => {
          outcome = result;
          child.stdin.end();
        });
        return;
      }
      if (ended) return kill('the job called the engine after it ended');
      if (
        typeof m.id !== 'number' ||
        !(HOST_CALLS as readonly unknown[]).includes(m.call) ||
        !Array.isArray(m.args)
      ) {
        return kill('the job sent a malformed host call');
      }
      if (++calls > RUNNER_LIMITS.hostCalls) {
        return kill(`more than ${RUNNER_LIMITS.hostCalls} host calls in one run`);
      }
      answer(m.id, m.call as HostCall, m.args);
    };

    void (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of child.stdout) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > RUNNER_LIMITS.stdoutBytes) {
          kill(`more than ${RUNNER_LIMITS.stdoutBytes} bytes on stdout`);
          break;
        }
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
      }
    })();
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(
          -RUNNER_LIMITS.stderrTail,
        );
      }
    })();

    write({ job: r.job, input: r.input, timezone: r.timezone });

    void child.exited.then(async () => {
      clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      r.signal?.removeEventListener('abort', onAbort);
      // Bounded: the child is gone, and a stalled call must not hold the slot forever.
      await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(10_000)]);
      const tail = stderr.trim() ? ` — stderr: ${stderr.trim()}` : '';
      if (failure) return reject(new Error(`${failure}${tail}`));
      if (outcome && 'ok' in outcome) return resolve();
      if (outcome) return reject(new Error(`${outcome.error}${tail}`));
      const how = child.signalCode
        ? `was killed by ${child.signalCode} (out of memory, or a ceiling outside the engine)`
        : `exited with code ${child.exitCode}`;
      reject(new Error(`the job process ${how} before it ended${tail}`));
    });
  });
}

/** Resident size of `pid` in KiB, from /proc; null when it cannot be read. */
function rssKb(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

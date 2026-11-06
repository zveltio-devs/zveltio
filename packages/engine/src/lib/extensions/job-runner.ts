/**
 * The Deno job runner (ADR 0022): one Deno process per run, with no
 * permissions at all. The bootstrap is the main module and `jobs.js` is
 * imported from the start line, both as `data:` URLs, so the process reads
 * no file; DENO_DIR points where it cannot create one, so it writes none.
 *
 * Deno opens no socket, reads no environment, writes no file. Everything the
 * job reaches is a request to the engine: one JSON line per message on
 * stdin/stdout, answered by `call`, which the caller binds to the job's
 * principal, tenant and declared collections. The child supplies only the
 * arguments of a call, never who it acts as.
 *
 * Where it runs (ADR 0023 decision 2): on the `runner` transport, in the
 * extension's own runner, under the runner's uid drop and socket ban; the
 * engine writes `JOB <memoryMb> <timeoutSeconds>` and then speaks the same
 * lines over the runner's socket, and the runner ends with one `{"runner":…}`
 * line saying how the process ended. On `process` (development, tests), as
 * the engine's child. Production never runs one as the engine's child: there
 * the jobs wait (`jobPlacement`).
 *
 * Ceilings, each of which kills the child (SIGKILL) and fails the run: the
 * wall clock (`timeoutSeconds`), memory, 1,000 host calls,
 * 16 MiB of stdout, a malformed line. Memory is bounded three ways because no
 * one way is enough: `--max-old-space-size` caps the V8 heap but not
 * ArrayBuffers; a cgroup caps everything where there is one (a local scope,
 * the runner unit's MemoryMax); and the process that spawned the child reads
 * its resident size from /proc and kills it past the budget — on the runner,
 * the runner, since the engine cannot see that process. RLIMIT_AS (ADR 0022
 * "prlimit --as") cannot be used: V8's sandbox reserves about 1 TiB of
 * address space, so Deno aborts at start under any limit below it (measured
 * 2026-11-05, Deno 2.9.8: dies at 32 GiB, starts at 1.1 TiB).
 */

import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun';
import { cgroupLimitAvailable, limitedCommand } from '../edge-functions/subprocess-runner.js';
import { extensionTransport } from '../worker-extension-transport.js';
import { ensureDeno } from './deno.js';

export const RUNNER_LIMITS = {
  hostCalls: 1000,
  stdoutBytes: 16 * 1024 * 1024,
  /** Deno's own resident size before a job allocates anything, added to `memoryMb`. */
  runtimeMb: 64,
  stderrTail: 2048,
  watchdogMs: 50,
};

/**
 * RLIMIT_CPU: a backstop for a child nobody supervises any more (its runner or
 * engine died mid-loop), not the timeout — Deno's threads spend CPU faster than
 * the wall clock, and a limit at `timeoutSeconds` killed runs before it fired.
 */
const cpuSeconds = (timeoutSeconds: number) => 2 * timeoutSeconds;

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
  /** The extension whose runner runs it, on the `runner` transport. */
  extName: string;
  /** The engine's verified Deno, for the `process` transport. */
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
 * job's name, input, time zone and code arrive as the first stdin line.
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
    const mod = await import('data:text/javascript;base64,' + start.code);
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

const BOOTSTRAP_URL = `data:text/javascript;base64,${Buffer.from(RUNNER_BOOTSTRAP).toString('base64')}`;

/**
 * Where a run goes: the extension's runner, or (development) the engine's
 * child. Throws in production on the `process` transport, which would run
 * the job under the engine's uid (ADR 0023 decision 2): its jobs wait.
 */
export function jobPlacement(): 'runner' | 'process' {
  const t = extensionTransport();
  if (t === 'process' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'in production a Deno job runs only on the extension runner; ZVELTIO_EXT_TRANSPORT=process ' +
        "would run it under the engine's uid: unset it",
    );
  }
  return t;
}

/**
 * Whether `extName`'s runner answers now, or no runner is needed (`process`).
 * The pump asks before claiming from its queues: a run claimed while the runner
 * is down would fail, spend a retry, and after enough of them be dropped
 * (ADR 0022: without a way to run them, jobs wait). A connection opened and
 * closed with no byte sent spawns nothing on the runner.
 */
export async function runnerAnswers(extName: string): Promise<boolean> {
  if (jobPlacement() !== 'runner') return true;
  try {
    const { startRunner } = await import('../ext-runner.js');
    const path = await startRunner(extName);
    return await new Promise<boolean>((resolve) => {
      const sock = connect(path);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 2000);
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  } catch {
    return false;
  }
}

/** Run one job in Deno. Resolves when it succeeded; rejects, saying why, otherwise. */
export async function runInDeno(r: RunnerRun): Promise<void> {
  return supervise(r, jobPlacement() === 'runner' ? await overRunner(r) : spawnLocal(r));
}

/** How a process ended, as far as the side that spawned it saw. */
interface Ended {
  /** The ceiling that killed it, when one did. */
  failure?: string;
  how: string;
  stderr: string;
}

/** A running job process: the engine's child, or one on the runner across a socket. */
interface JobProc {
  write(data: string | Uint8Array): void;
  /** The run is over: let the process go. */
  end(): void;
  kill(): void;
  stdout: AsyncIterable<Uint8Array>;
  exited: Promise<Ended>;
  /** Across the runner: its last `{"runner":…}` line says how the process ended. */
  remote?: boolean;
}

/**
 * Created once, mode 0500, and never written: DENO_DIR points inside it, so
 * Deno — which otherwise keeps caches there — writes nothing (measured: with
 * no DENO_DIR a uid without a passwd entry cannot start at all).
 */
let noDenoDir: string | null = null;
function denoDir(): string {
  if (!noDenoDir) {
    const dir = mkdtempSync(join(tmpdir(), 'zv-deno-'));
    chmodSync(dir, 0o500);
    noDenoDir = join(dir, 'none');
  }
  return noDenoDir;
}

function denoArgv(deno: string, memoryMb: number): string[] {
  return [
    deno,
    'run',
    '--no-prompt',
    '--no-config',
    '--no-remote',
    '--no-npm',
    `--v8-flags=--max-old-space-size=${memoryMb}`,
    BOOTSTRAP_URL,
  ];
}

/**
 * Spawn `cmd` (Deno under its ceilings) with the RSS watchdog. The process
 * gets fds 0-2 and nothing else.
 */
function spawnDeno(cmd: string[], env: Record<string, string>, memoryMb: number): JobProc {
  const child = spawn({ cmd, cwd: '/', env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let failure: string | undefined;
  // Under another uid a kill needs CAP_KILL; a throw must not take the caller down.
  const kill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone, or not ours to kill: its exit or the connection's end settles the run */
    }
  };
  const budgetKb = (memoryMb + RUNNER_LIMITS.runtimeMb) * 1024;
  const watchdog =
    process.platform === 'linux'
      ? setInterval(() => {
          const kb = rssKb(child.pid);
          if (kb !== null && kb > budgetKb) {
            failure ??= `exceeded the memory limit of ${memoryMb} MB (memoryMb)`;
            kill();
          }
        }, RUNNER_LIMITS.watchdogMs)
      : null;
  let stderr = '';
  const stderrRead = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-RUNNER_LIMITS.stderrTail);
    }
  })();
  return {
    write(data) {
      try {
        child.stdin.write(data);
        child.stdin.flush();
      } catch {
        /* the child is gone; its exit settles the run */
      }
    },
    end: () => {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
    },
    kill,
    stdout: child.stdout,
    exited: child.exited.then(async () => {
      if (watchdog) clearInterval(watchdog);
      await stderrRead.catch(() => undefined);
      const how = child.signalCode
        ? `was killed by ${child.signalCode} (out of memory, or a ceiling outside the engine)`
        : `exited with code ${child.exitCode}`;
      return { failure, how, stderr: stderr.trim() };
    }),
  };
}

/** The `process` transport: the engine's child, under the ceilings this host can enforce. */
function spawnLocal(r: RunnerRun): JobProc {
  // `limitedCommand` drops every ceiling for an argument with a quote in it; refuse instead.
  if (r.deno.includes("'")) throw new Error(`the Deno path contains a quote: ${r.deno}`);
  const useCgroup = cgroupLimitAvailable();
  const budgetMb = r.memoryMb + RUNNER_LIMITS.runtimeMb;
  // No RLIMIT_AS (see the header): memory goes to the cgroup when there is one, never `ulimit -v`.
  const cmd = limitedCommand(
    denoArgv(r.deno, r.memoryMb),
    useCgroup ? budgetMb : 0,
    cpuSeconds(r.timeoutSeconds),
    useCgroup,
  );
  // DENO_DIR, and what systemd-run needs to create the scope, which the inner shell unsets.
  const env: Record<string, string> = { DENO_DIR: denoDir() };
  if (useCgroup) {
    for (const k of ['PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  }
  return spawnDeno(cmd, env, r.memoryMb);
}

/**
 * The first line on a job connection: `JOB <memoryMb> <timeoutSeconds>`. The
 * runner tells it from an extension's channel by its first byte — a frame
 * starts with its length's top byte, at most 0x02 — and from an edge
 * invocation's `EDGE`.
 */
export const JOB_HEADER_TAG = 'JOB';

export function parseJobHeader(line: string): { memoryMb: number; timeoutSeconds: number } | null {
  const m = /^JOB ([1-9]\d{0,3}) ([1-9]\d{0,3})$/.exec(line);
  return m ? { memoryMb: Number(m[1]), timeoutSeconds: Number(m[2]) } : null;
}

/** The `runner` transport: the extension's runner spawns it; closing the connection kills it. */
async function overRunner(r: RunnerRun): Promise<JobProc> {
  const { startRunner } = await import('../ext-runner.js');
  const path = await startRunner(r.extName).catch((err: Error) => {
    throw new Error(`the extension runner is unreachable: ${err.message}`);
  });
  const sock = connect(path);
  let failure: string | undefined;
  sock.on('error', (err) => {
    failure ??= `the extension runner (${path}): ${err.message}`;
  });
  sock.write(`${JOB_HEADER_TAG} ${r.memoryMb} ${r.timeoutSeconds}\n`);
  return {
    remote: true,
    write: (data) => {
      if (!sock.destroyed) sock.write(data);
    },
    end: () => sock.destroy(),
    kill: () => sock.destroy(),
    // Not the socket's own iterator: it throws on the destroy that ends a run.
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        // A reader that stopped (a ceiling) leaves the stream closed: later chunks are dropped.
        sock.on('data', (d: Buffer) => {
          try {
            c.enqueue(new Uint8Array(d));
          } catch {
            /* closed */
          }
        });
        sock.on('close', () => {
          try {
            c.close();
          } catch {
            /* closed */
          }
        });
      },
    }),
    exited: new Promise((resolve) =>
      sock.on('close', () =>
        resolve({ failure, how: 'ended without the runner saying how', stderr: '' }),
      ),
    ),
  };
}

/**
 * Runner side of one job connection (`first` holds the bytes read so far):
 * spawn Deno through `wrap` — the uid drop and the socket ban in containers,
 * the unit's own on systemd — without RLIMIT_AS, under RLIMIT_CPU and the
 * RSS watchdog; pipe the connection to it; end with one `{"runner":…}` line.
 * The child could print such a line itself; it describes only its own run,
 * and the runner's comes last.
 */
export function serveJobConnection(
  conn: Socket,
  first: Buffer,
  wrap: (
    argv: string[],
    opts?: { addressSpace?: boolean },
  ) => { argv: string[]; release?: () => void },
  // The runner verifies the binary it runs, and never downloads one: it has no network.
  locate: () => Promise<string> = () => ensureDeno({ download: false }),
): void {
  let buf = first;
  let header: { memoryMb: number; timeoutSeconds: number } | null = null;
  let proc: JobProc | null = null;
  const report = (ended: Ended) => {
    if (!conn.destroyed) conn.end(`\n${JSON.stringify({ runner: ended })}\n`);
  };
  const onData = (chunk: Buffer) => {
    if (proc) return proc.write(chunk);
    buf = Buffer.concat([buf, chunk]);
    if (header) return; // Deno is being located; the bytes wait in `buf`.
    const nl = buf.indexOf(10);
    if (nl === -1) {
      if (buf.length > 64) conn.destroy();
      return;
    }
    header = parseJobHeader(buf.subarray(0, nl).toString('latin1'));
    if (!header) return void conn.destroy();
    buf = buf.subarray(nl + 1);
    const { memoryMb, timeoutSeconds } = header;
    void locate().then(
      (deno) => {
        if (conn.destroyed) return;
        if (deno.includes("'")) {
          return report({
            failure: `the Deno path contains a quote: ${deno}`,
            how: '',
            stderr: '',
          });
        }
        const { argv, release } = wrap(
          limitedCommand(denoArgv(deno, memoryMb), 0, cpuSeconds(timeoutSeconds), false),
          {
            addressSpace: false,
          },
        );
        const p = spawnDeno(argv, { DENO_DIR: denoDir() }, memoryMb);
        proc = p;
        p.write(buf);
        const relayed = (async () => {
          for await (const out of p.stdout) if (!conn.destroyed) conn.write(out);
        })();
        // After the last byte of its stdout: the status line is the connection's last.
        void Promise.all([p.exited, relayed.catch(() => undefined)]).then(([ended]) => {
          release?.();
          report(ended);
        });
      },
      (err: Error) =>
        report({
          failure: `the runner has no Deno to run the job: ${err.message}`,
          how: '',
          stderr: '',
        }),
    );
  };
  const kill = () => proc?.kill();
  conn.on('close', kill);
  conn.on('error', kill);
  conn.on('data', onData);
  // The router paused the connection to read its first chunk.
  conn.resume();
  onData(Buffer.alloc(0));
}

/** One run, whichever side its process is on: the protocol and every ceiling the engine holds. */
function supervise(r: RunnerRun, proc: JobProc): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let failure: string | null = null;
    let outcome: { ok: true } | { error: string } | null = null;
    let reported: Partial<Ended> | null = null;
    let ended = false;
    let calls = 0;
    let stdoutBytes = 0;
    const inFlight = new Set<Promise<void>>();

    const kill = (why: string) => {
      failure ??= why;
      proc.kill();
    };
    const write = (m: unknown) => {
      if (outcome || failure) return;
      proc.write(`${JSON.stringify(m)}\n`);
    };

    const timer = setTimeout(
      () => kill(`killed after the timeout of ${r.timeoutSeconds}s`),
      r.timeoutSeconds * 1000,
    );
    const onAbort = () => kill('the extension was unloaded while the job ran');
    r.signal?.addEventListener('abort', onAbort);
    if (r.signal?.aborted) onAbort();

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
        runner?: unknown;
      };
      try {
        m = JSON.parse(line);
      } catch {
        return kill('the job wrote a line that is not a message');
      }
      if (m === null || typeof m !== 'object')
        return kill('the job wrote a line that is not a message');
      if (proc.remote && m.runner && typeof m.runner === 'object') {
        // The last one wins: the runner's own comes after the child's stdout ends.
        const s = m.runner as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
        reported = { failure: str(s.failure), how: str(s.how), stderr: str(s.stderr) };
        return;
      }
      if (m.done === true) {
        if (ended) return kill('the job ended twice');
        ended = true;
        const result =
          m.ok === true ? { ok: true as const } : { error: String(m.error ?? 'failed') };
        // Calls in flight finish first; one sent after `done` is refused below.
        void Promise.allSettled([...inFlight]).then(() => {
          outcome = result;
          proc.end();
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
      for await (const chunk of proc.stdout) {
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

    const code = Buffer.from(r.code).toString('base64');
    write({ job: r.job, input: r.input, timezone: r.timezone, code });

    void proc.exited.then(async (st) => {
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
      // Bounded: the child is gone, and a stalled call must not hold the slot forever.
      await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(10_000)]);
      const stderr = (reported?.stderr ?? st.stderr).slice(-RUNNER_LIMITS.stderrTail).trim();
      const tail = stderr ? ` — stderr: ${stderr}` : '';
      const why = failure ?? reported?.failure ?? st.failure;
      if (why) return reject(new Error(`${why}${tail}`));
      if (outcome && 'ok' in outcome) return resolve();
      if (outcome) return reject(new Error(`${outcome.error}${tail}`));
      reject(new Error(`the job process ${reported?.how ?? st.how} before it ended${tail}`));
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

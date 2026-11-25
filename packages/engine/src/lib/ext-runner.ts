/**
 * `zveltio ext-runner` — the bare-metal extension runner (RFC
 * extension-runner, steps 3 and 3b).
 *
 * One systemd service per extension, `zveltio-ext-runner@<instance>`, with
 * `DynamicUser=yes`: each extension runs under its own uid, in its own cgroup
 * (MemoryMax) and with no network (IPAddressDeny=any: routes and actions have
 * no egress, ADR 0022; a job's egress goes through the engine; the unit's
 * RestrictAddressFamilies=AF_UNIX, and in every process the runner starts the
 * socket ban, ADR 0023). The engine keeps `NoNewPrivileges=yes` and so
 * cannot start a process under another uid; it asks systemd to start the
 * instance over D-Bus (`systemctl start`, allowed by the polkit rule `setup`
 * writes) and connects to the instance's unix socket. Each accepted
 * connection gets a runtime process; the connection's bytes are piped to its
 * stdin/stdout unchanged — the #979 frames, which only the engine and the
 * runtime decode. A closed connection kills the process; an exited process
 * closes the connection.
 *
 * What makes it a boundary: the runtime runs under a uid that cannot read the
 * engine's files (`.env`, storage), the engine's process state, or another
 * extension's runner directory, and it holds no database connection: no SQL
 * crosses (RFC extension-model-v3 decision 2), only `host` calls, which the
 * engine answers; the engine is also the only broker between extensions.
 *
 * Who may connect: only the engine's uid, read from the kernel with
 * SO_PEERCRED.
 *
 * Containers (step 4) have no systemd: one runner container serves every
 * extension on a socket in a volume shared with the engine
 * (`ZVELTIO_EXT_RUNNER_SOCKET` set on both sides), starts as root with only
 * CAP_SETUID, CAP_SETGID and CAP_KILL, and gives every process a uid of its own from
 * `ZVELTIO_EXT_RUNNER_UID_BASE`, under a seccomp filter that bans sockets
 * (socket-ban.ts, ADR 0023): its network is the container's (`network_mode:
 * none` in compose, shared on a PaaS), and the filter keeps it out of reach.
 * One container (Fly.io, Railway, Render,
 * `docker run --user 0:0`): `docker/zveltio-entrypoint.sh` starts it beside
 * the engine, which it drops to the engine's uid.
 */

import { nodeEnv } from './operational-modes.js';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { WORKER_RUNTIME_SOURCE } from './worker-extension-runtime-source.generated.js';
import { createHash } from 'node:crypto';
import { checkSocketBan, socketBanned } from './socket-ban.js';

// Bun's `--compile` mode does NOT auto-bundle workers. Embed the pre-
// compiled worker JS as a string constant and write it to a temp file
// at first-spawn — Bun's Worker constructor accepts an absolute disk
// path. See packages/engine/scripts/gen-worker-source.ts.
let _workerRuntimePath: string | null = null;
export function ensureWorkerRuntimeOnDisk(): string {
  if (_workerRuntimePath && existsSync(_workerRuntimePath)) return _workerRuntimePath;
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-worker-'));
  const path = join(dir, 'worker-extension-runtime.mjs');
  writeFileSync(path, WORKER_RUNTIME_SOURCE, 'utf8');
  _workerRuntimePath = path;
  return path;
}

/**
 * The uid of the process at the other end of a unix socket, from the kernel
 * (SO_PEERCRED), or null when it cannot be read — which the caller treats as
 * a refusal. Bun does not expose the option, so it is one libc call through
 * `bun:ffi`.
 */
type Getsockopt = (fd: number, level: number, name: number, val: unknown, len: unknown) => number;
let getsockopt: Getsockopt | null = null;
async function peerUid(socket: Socket): Promise<number | null> {
  // Bun keeps the descriptor on the internal handle.
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) return null;
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  if (!getsockopt) {
    const libc = dlopen('libc.so.6', {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    getsockopt = libc.symbols.getsockopt as unknown as Getsockopt;
  }
  const SOL_SOCKET = 1;
  const SO_PEERCRED = 17;
  const cred = new Int32Array(3); // struct ucred { pid, uid, gid }
  const len = new Uint32Array([12]);
  if (getsockopt!(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(len)) !== 0) return null;
  return cred[1];
}

export async function runExtRunner(): Promise<never> {
  const engineUid = Number.parseInt(process.env.ZVELTIO_ENGINE_UID ?? '', 10);
  if (!Number.isInteger(engineUid) || engineUid < 0) {
    console.error('[ext-runner] ZVELTIO_ENGINE_UID must be the numeric uid of the engine service');
    process.exit(1);
  }
  // Container mode (RFC step 4): one runner serves every extension, so the
  // uid per extension that systemd gives step 3b comes from here — the runner
  // starts as root with only CAP_SETUID, CAP_SETGID and CAP_KILL and drops each process to a
  // uid of its own. Without it every extension shares one uid, and one of them
  // can replace the runner's socket and be handed the next extension's channel.
  const uidBase = process.env.ZVELTIO_EXT_RUNNER_UID_BASE
    ? Number(process.env.ZVELTIO_EXT_RUNNER_UID_BASE)
    : null;
  if (uidBase !== null && (!Number.isInteger(uidBase) || uidBase < 1000 || uidBase === engineUid)) {
    console.error('[ext-runner] ZVELTIO_EXT_RUNNER_UID_BASE must be an integer ≥ 1000');
    process.exit(1);
  }
  // Same uid as the engine = no boundary at all. Refuse rather than run as
  // a slower in-process worker that looks isolated. Root only to drop each
  // process to its own uid, never to run one.
  const ownUid = process.getuid?.();
  if (ownUid === undefined || ownUid === engineUid || (ownUid === 0) !== (uidBase !== null)) {
    console.error(
      '[ext-runner] refusing to run as the engine uid, or as root without ' +
        'ZVELTIO_EXT_RUNNER_UID_BASE (or with it, as anything but root) — start it through its unit',
    );
    process.exit(1);
  }

  const path = process.env.ZVELTIO_EXT_RUNNER_SOCKET;
  if (!path) {
    console.error('[ext-runner] ZVELTIO_EXT_RUNNER_SOCKET is not set');
    process.exit(1);
  }
  if (uidBase !== null) {
    // The extensions run as other uids beside the socket and the runtime. A
    // directory they can rename entries in — a Kubernetes emptyDir is 0777, no
    // sticky bit — lets one of them put its own socket in the runner's place,
    // or its own runtime under the next extension, and be handed that
    // extension's channel. Both directories must be root's; the socket's is
    // closed to 0755, /tmp gets the sticky bit.
    const refused =
      missingCapabilities(readProcStatus()) ??
      closeSharedDirs([
        [dirname(path), 0o755],
        [tmpdir(), 0o1777],
      ]) ??
      checkUidRange(uidBase);
    if (refused) {
      console.error(`[ext-runner] ${refused}`);
      process.exit(1);
    }
  }

  const runtimePath = ensureWorkerRuntimeOnDisk();
  // Edge functions (RFC step 5) run here too; importing the module writes their
  // bootstrap, after the checks above made /tmp safe to write into.
  const { edgeBootstrapPath, serveEdgeConnection } = await import(
    './edge-functions/subprocess-runner.js'
  );
  // Deno jobs (ADR 0023 decision 2) run here too, under the same wrap.
  const { serveJobConnection } = await import('./extensions/job-runner.js');
  // The processes run under other uids and must read the runtime and bootstrap.
  if (uidBase !== null) {
    chmodSync(dirname(runtimePath), 0o755);
    chmodSync(dirname(edgeBootstrapPath), 0o755);
    chmodSync(edgeBootstrapPath, 0o644);
  }
  const wrap = runnerWrap(uidBase === null ? null : uidAllocator(uidBase));
  const unbanned = checkSocketBan(wrap);
  if (unbanned) {
    console.error(`[ext-runner] ${unbanned}`);
    process.exit(1);
  }
  const route = {
    workerArgv: [process.execPath, runtimePath],
    // Only what the runtime needs. The runner's own environment is the unit's,
    // and nothing of the engine's ever reaches this process.
    childEnv: { NODE_ENV: nodeEnv() ?? 'production', BUN_BE_BUN: '1' },
    wrap,
    serveEdge: serveEdgeConnection,
    serveJob: (conn: Socket, first: Buffer, w: RouteWrap) => serveJobConnection(conn, first, w),
  };

  const server = createServer(async (conn) => {
    const uid = await peerUid(conn).catch(() => null);
    if (uid !== engineUid) {
      console.warn(`[ext-runner] refused a connection from uid ${uid ?? 'unknown'}`);
      conn.destroy();
      return;
    }
    routeConnection(conn, route);
  });

  // Bound and opened under a name no one waits for, then moved into place: the
  // engine connects as soon as `path` exists (`startInstance`), and a socket
  // seen there before its chmod refused it with EACCES. Every lazy start
  // connects at once (ADR 0062 d3), so that window was hit, not hypothetical.
  const staging = `${path}.${process.pid}.tmp`;
  rmSync(path, { force: true });
  rmSync(staging, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(staging, resolve);
  });
  // Anyone may reach connect(); SO_PEERCRED decides who is served.
  chmodSync(staging, 0o666);
  renameSync(staging, path);
  console.log(`[ext-runner] listening on ${path} for uid ${engineUid}`);
  try {
    await notifyReady();
  } catch (err) {
    console.error(`[ext-runner] ${(err as Error).message}`);
    process.exit(1);
  }

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return new Promise<never>(() => {});
}

/**
 * Tell systemd the runner listens (`Type=notify`, sd_notify(3)): `systemctl
 * start` then returns with the socket in place, and the engine connects at once
 * instead of polling for it (ADR 0062 step 2b: the poll cost up to 100 ms of
 * every cold start). No NOTIFY_SOCKET (containers, a unit written before this):
 * nothing to tell. A datagram through libc: Bun has no AF_UNIX datagram socket.
 * Throws when it cannot be sent: the unit would wait for it until its start
 * timeout, so the runner exits instead and the start fails at once.
 */
export async function notifyReady(target = process.env.NOTIFY_SOCKET): Promise<void> {
  if (!target) return;
  // struct sockaddr_un { sa_family_t sun_family; char sun_path[108]; }; '@' is
  // the abstract namespace, spelled with a leading NUL and no trailing one.
  const name = Buffer.from(target.startsWith('@') ? `\0${target.slice(1)}` : `${target}\0`);
  if (name.length > 108) throw new Error(`NOTIFY_SOCKET is too long: ${target}`);
  const addr = Buffer.alloc(2 + name.length);
  addr.writeUInt16LE(1, 0); // AF_UNIX
  name.copy(addr, 2);
  const msg = Buffer.from('READY=1');
  const { dlopen, FFIType: T, ptr, read } = await import('bun:ffi');
  const libc = dlopen('libc.so.6', {
    socket: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
    sendto: { args: [T.i32, T.ptr, T.u64, T.i32, T.ptr, T.u32], returns: T.i64 },
    close: { args: [T.i32], returns: T.i32 },
    __errno_location: { returns: T.ptr },
  });
  const c = libc.symbols;
  try {
    const SOCK_DGRAM_CLOEXEC = 2 | 0o2000000;
    const fd = c.socket(1, SOCK_DGRAM_CLOEXEC, 0);
    const sent =
      fd < 0 ? -1 : Number(c.sendto(fd, ptr(msg), msg.length, 0, ptr(addr), addr.length));
    const errno = sent < 0 ? read.i32(c.__errno_location()!, 0) : 0;
    if (fd >= 0) c.close(fd);
    if (sent !== msg.length) throw new Error(`could not tell systemd it is ready (errno ${errno})`);
  } finally {
    libc.close();
  }
}

/**
 * Serve one accepted connection: an edge invocation or a Deno job when it
 * starts with their header, otherwise an extension's frame channel, piped to
 * a runtime process unchanged. Nothing is spawned until the first bytes say
 * which.
 */
export function routeConnection(
  conn: Socket,
  opts: {
    workerArgv: string[];
    childEnv: Record<string, string>;
    wrap: RouteWrap;
    serveEdge: (conn: Socket, first: Buffer, wrap: RouteWrap) => void;
    serveJob?: (conn: Socket, first: Buffer, wrap: RouteWrap) => void;
  },
): void {
  conn.once('data', (first: Buffer) => {
    // Paused before anything else is read: a chunk emitted with no listener
    // is lost.
    conn.pause();
    if (first[0] === EDGE_TAG_BYTE) {
      opts.serveEdge(conn, first, opts.wrap);
      return;
    }
    if (first[0] === JOB_TAG_BYTE) {
      if (opts.serveJob) opts.serveJob(conn, first, opts.wrap);
      else conn.destroy();
      return;
    }
    // Memory and tasks: the unit's cgroup limits, per extension, or in
    // container mode the rlimits `wrap` sets (limitArgv).
    const { argv, env, release } = opts.wrap(opts.workerArgv, { env: opts.childEnv });
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: env ?? opts.childEnv,
      cwd: '/',
    });
    if (release) child.on('exit', release);
    child.stdin.write(first);
    conn.pipe(child.stdin);
    child.stdout.pipe(conn);
    // kill() throws EPERM on a child under another uid when the runner lacks
    // CAP_KILL — measured: the throw took the runner and every extension down.
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        console.error(`[ext-runner] could not kill pid ${child.pid}: ${(err as Error).message}`);
      }
    };
    conn.on('close', kill);
    conn.on('error', kill);
    child.stdin.on('error', () => conn.destroy());
    child.on('exit', () => conn.destroy());
  });
}

/**
 * How the runner starts a process: the argv and environment to spawn instead
 * (the socket ban's loader, a uid drop), and what to give back when it exits.
 * `addressSpace: false` for Deno, which cannot start under RLIMIT_AS
 * (job-runner.ts). No `env` back: spawn the one passed in.
 */
export type RouteWrap = (
  argv: string[],
  opts: { env: Record<string, string>; addressSpace?: boolean },
) => { argv: string[]; env?: Record<string, string>; release?: () => void };
// 'E' of the edge header; see EDGE_HEADER_TAG in edge-functions/subprocess-runner.ts.
const EDGE_TAG_BYTE = 0x45;
// 'J' of the job header; see JOB_HEADER_TAG in extensions/job-runner.ts.
const JOB_TAG_BYTE = 0x4a;

/**
 * How the runner starts every process: under the socket ban (ADR 0023),
 * loaded by this binary before exec (socketBanned) — the runner itself keeps
 * AF_UNIX for its socket; with `allocate` (container mode, the bare-metal
 * `edge` instance) also under a uid of its own and rlimits. The ban is
 * outermost: it loads as root, before prlimit and setpriv, and RLIMIT_AS
 * never meets the loader's JIT.
 */
export function runnerWrap(allocate: ReturnType<typeof uidAllocator> | null): RouteWrap {
  return (argv, opts) => {
    if (!allocate) return socketBanned(argv, opts.env);
    const { uid, release } = allocate();
    const limited = limitArgv(setprivArgv(uid, argv), opts.addressSpace ?? true);
    return { release, ...socketBanned(limited, opts.env) };
  };
}

/**
 * Container mode: a uid per extension process, from `base` up. A uid stays
 * taken until `release`; ponytail: 65536 concurrent processes before a wrap
 * hands out a live one.
 */
export function uidAllocator(base: number): () => { uid: number; release: () => void } {
  const live = new Set<number>();
  let next = 0;
  return () => {
    let offset = next;
    for (let i = 0; live.has(base + offset) && i < 65536; i++) offset = (offset + 1) % 65536;
    next = (offset + 1) % 65536;
    const uid = base + offset;
    live.add(uid);
    return { uid, release: () => live.delete(uid) };
  };
}

/**
 * Bun's spawn ignores `uid` without a word (measured: the child ran as root).
 */
export function setprivArgv(uid: number, argv: string[]): string[] {
  return [
    'setpriv',
    `--reuid=${uid}`,
    `--regid=${uid}`,
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...argv,
  ];
}

/**
 * Threads count against RLIMIT_NPROC, and a runtime process idles at 6 to 10
 * (measured); 64 leaves room for Workers and the odd child, not a fork bomb.
 */
const EXT_MAX_TASKS = 64;
/**
 * Measured on Bun 1.3.14 (alpine, 8 MB buffers until failure): 1024 MB of
 * address space leaves about 300 MB of heap; 1152-1408 MB crash at start,
 * 2500 MB leaves 48 MB, 4096 MB 1.2 GB. Not monotonic, so not a setting: the
 * value edge functions already use (EDGE_MEMORY_LIMIT_MB's floor).
 */
const EXT_ADDRESS_SPACE_MB = 1024;
/**
 * Container mode (ADR 0062, F20): no cgroup per process, so a priority instead —
 * a tenth of the engine's share when both want the CPU (nice 10 weighs 110
 * against nice 0's 1024), as the unit's CPUWeight=10 is on bare metal. Measured
 * on 2 vCPUs, a priority does not stop a loop's cost to the engine (even
 * SCHED_IDLE: +77% p95); the container's CPU limit and the deadline kill bound it.
 */
const EXT_NICE = 10;

/**
 * Container mode: a container gives no cgroup per extension (a PaaS gives one
 * container in all), so each process gets rlimits instead — tasks against a
 * fork bomb, address space against a runaway heap, which then kills that
 * process alone (measured: Bun aborts on the failed allocation). Set by
 * prlimit(1), as root, before setpriv drops the uid, so the extension cannot
 * raise them. Not a shell's `ulimit`: dash spells the task limit `-p`, busybox
 * and bash `-u`.
 * The CPU: `EXT_NICE`, with RLIMIT_NICE 0 so the extension's uid cannot take
 * it back (an unprivileged process may lower its nice only down to 20 minus
 * that limit).
 * ponytail: RLIMIT_AS bounds virtual memory, not RSS, and the container's
 * memory is still shared; a cgroup per extension (systemd mode) is the limit.
 * Without `addressSpace` (Deno): its RSS watchdog and the container's limit.
 */
export function limitArgv(argv: string[], addressSpace = true): string[] {
  return [
    'prlimit',
    `--nproc=${EXT_MAX_TASKS}`,
    ...(addressSpace ? [`--as=${EXT_ADDRESS_SPACE_MB * 1024 * 1024}`] : []),
    '--nice=0',
    '--',
    'nice',
    '-n',
    String(EXT_NICE),
    ...argv,
  ];
}

type SpawnSync = (argv: string[]) => { exitCode: number | null; stdout: Buffer; stderr?: Buffer };

/** The capabilities the chart and the compose overlay add, by bit (linux/capability.h). */
const RUNNER_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['CAP_KILL', 5],
  ['CAP_SETGID', 6],
  ['CAP_SETUID', 7],
];

function readProcStatus(): string {
  try {
    return readFileSync('/proc/self/status', 'utf8');
  } catch {
    return '';
  }
}

/**
 * Container mode: the refusal naming each capability the runner was started
 * without, or null. A platform that drops them (some PaaS run every container
 * without CAP_SETUID) otherwise fails later at the first uid switch, with
 * setpriv's message instead of the one setting to change.
 */
export function missingCapabilities(procStatus: string): string | null {
  const hex = /^CapEff:\s*([0-9a-f]+)$/im.exec(procStatus)?.[1];
  if (!hex) return null; // not Linux /proc: checkUidRange still decides
  const eff = BigInt(`0x${hex}`);
  const missing = RUNNER_CAPS.filter(([, bit]) => !(eff & (1n << BigInt(bit)))).map(([n]) => n);
  return missing.length === 0
    ? null
    : `started without ${missing.join(', ')}: give the runner container ` +
        'cap_add [SETUID, SETGID, KILL] (Helm: securityContext.capabilities.add)';
}

/**
 * Container mode: check the kernel lets the runner switch to both ends of the
 * range `uidAllocator` hands out; the refusal, or null. Without CAP_SETUID, or
 * in a user namespace that maps fewer ids (docker userns-remap maps 65536), an
 * extension would fail at load long after the runner said it was listening.
 */
export function checkUidRange(
  base: number,
  run: SpawnSync = (argv) => Bun.spawnSync(argv, { stderr: 'pipe' }),
): string | null {
  for (const uid of [base, base + 65535]) {
    const r = run(setprivArgv(uid, ['id', '-u']));
    const got = r.stdout.toString().trim();
    if (r.exitCode !== 0 || got !== String(uid)) {
      const why = r.stderr?.toString().trim() || `it ran as ${got || 'nothing'}`;
      return (
        `cannot run a process as uid ${uid} (${why}): the runner needs root with ` +
        `CAP_SETUID and CAP_SETGID, and uids ${base}-${base + 65535} usable`
      );
    }
  }
  return null;
}

/**
 * Give each directory its mode and check it belongs to root; the refusal, or
 * null. chmod(1): Bun's chmodSync drops the sticky bit without a word
 * (measured: 0o1777 left the directory at 777).
 */
export function closeSharedDirs(dirs: ReadonlyArray<readonly [string, number]>): string | null {
  for (const [dir, mode] of dirs) {
    Bun.spawnSync(['chmod', mode.toString(8), dir]);
    const st = statSync(dir);
    if (st.uid !== 0 || (st.mode & 0o7777) !== mode) {
      return `${dir} must belong to root and be mode ${mode.toString(8)} in container mode`;
    }
  }
  return null;
}

// ── Engine side: one unit instance per extension ─────────────────────────

/** Where the engine keeps the Deno it downloads for jobs, under the extensions' directory. */
export const DENO_DIR_NAME = '.deno';

/**
 * ADR 0062 probe "security" (F15): close the extensions' directory `base` to
 * every uid but its owner, the engine's. On the runner each extension runs
 * under a uid of its own beside this directory (a bind on systemd, a shared
 * volume in compose, Helm and one container), and a 0755 tree let every
 * extension read every other's files. The runtime needs none of them: the
 * engine sends the bundle's bytes in `init`, and a Deno job's `jobs.js` crosses
 * the same way. What stays reachable is the Deno binary: `base` keeps only the
 * search bit for others (0711: no listing), `.deno` is left as it is, and every
 * other entry becomes 0700 (0600 for a file). Applied at every spawn, so an
 * install made before this, or a directory an update added, is closed too. A
 * symbolic link is left alone (chmod would change its target). Throws when the
 * engine cannot close one that is open: it does not own it, and then no
 * extension runs beside it.
 */
export function closeExtensionsDir(base: string): void {
  // Changed only when it is not so already: an entry the engine does not own
  // (a socket directory a runner made root's) passes when it is closed.
  const close = (path: string, others: number, mode: number) => {
    if ((statSync(path).mode & 0o077) !== others) chmodSync(path, mode);
  };
  try {
    close(base, 0o011, 0o711);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name === DENO_DIR_NAME || entry.isSymbolicLink()) continue;
      close(join(base, entry.name), 0, entry.isDirectory() ? 0o700 : 0o600);
    }
  } catch (err) {
    throw new Error(
      `the extensions' directory ${base} cannot be closed to the extension runner's uids ` +
        `(${(err as Error).message}): the engine must own it and everything directly in it`,
    );
  }
}

/**
 * The extensions' directory `extDir` was loaded from, for `closeExtensionsDir`:
 * `<base>/<name>`, as every load joins them. Anything else is refused rather
 * than guessed, since closing the wrong parent (a temporary directory) would
 * close it to everyone.
 */
export function extensionsBaseOf(extDir: string, extName: string): string {
  const suffix = `/${extName}`;
  const dir = extDir.replace(/\/+$/, '');
  if (!dir.endsWith(suffix) || dir.length === suffix.length) {
    throw new Error(
      `"${extName}" was loaded from ${extDir}, which is not <extensions dir>/${extName}`,
    );
  }
  return dir.slice(0, -suffix.length);
}

const RUNNER_DIR = '/run/zveltio-ext';

/**
 * The systemd instance name for an extension. Extension names are free-form
 * (`acme/my-ext`), and an escaped instance (`acme-my\x2dext`) breaks
 * `RuntimeDirectory=zveltio-ext/%i` — measured: "Failed to deserialize". So
 * the instance is the name reduced to `[a-z0-9_]`, made unique again by a
 * hash of the real name. At most 25 characters, so `User=zx_%i` stays within
 * the 31 a user name may have.
 */
export function runnerInstance(extName: string): string {
  const readable = extName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 16);
  const hash = createHash('sha256').update(extName).digest('hex').slice(0, 8);
  return `${readable}_${hash}`;
}

export function runnerUnit(extName: string): string {
  return `zveltio-ext-runner@${runnerInstance(extName)}.service`;
}

export function runnerSocketPath(extName: string): string {
  return join(RUNNER_DIR, runnerInstance(extName), 'runner.sock');
}

/** Where the extension's runner listens: the shared container socket, or its unit's. */
export function runnerSocketFor(extName: string): string {
  return process.env.ZVELTIO_EXT_RUNNER_SOCKET || runnerSocketPath(extName);
}

/**
 * Why no runner can be started from this engine, or null. The shared-socket
 * container mode needs ZVELTIO_EXT_RUNNER_SOCKET; bare metal needs systemd.
 * Neither means the engine runs as a non-root user in a container without a
 * runner (`--user 100:101`, a PaaS that forces the image's user): third-party
 * extensions are refused, and the message says so instead of "systemctl".
 */
export function runnerMissing(
  env: Record<string, string | undefined> = process.env,
  which: (bin: string) => string | null = (bin) => Bun.which(bin, { PATH: process.env.PATH ?? '' }),
): string | null {
  if (env.ZVELTIO_EXT_RUNNER_SOCKET || which('systemctl')) return null;
  return (
    'no extension runner in this container: ZVELTIO_EXT_RUNNER_SOCKET is not set and ' +
    'there is no systemd to start one, so third-party (worker) extensions are refused; ' +
    'first-party inline extensions are unaffected'
  );
}

/**
 * Whether something listens on `path` now. A connection opened and closed with
 * no byte sent spawns nothing on a runner.
 */
export function socketAnswers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Why no runner can serve `extName` now, or null — asked at load, where nothing
 * is spawned any more (ADR 0062 d3), so an engine without a runner still refuses
 * its worker extensions then rather than at their first call. The shared
 * container runner must listen; a systemd unit is started on use.
 */
export async function runnerUnavailable(extName: string): Promise<string | null> {
  const missing = runnerMissing();
  if (missing) return missing;
  const shared = process.env.ZVELTIO_EXT_RUNNER_SOCKET;
  if (shared && !(await socketAnswers(shared))) return `nothing listens on ${shared} (${extName})`;
  return null;
}

/** The `oom_kill` counter of a cgroup's `memory.events`, or null if unreadable. */
export function readOomKills(eventsFile: string): number | null {
  try {
    const n = /^oom_kill\s+(\d+)$/m.exec(readFileSync(eventsFile, 'utf8'))?.[1];
    return n === undefined ? null : Number(n);
  } catch {
    return null;
  }
}

/**
 * Kernel OOM kills so far in the cgroup the extension's process lives in: the
 * container's (shared-socket mode) or the extension's unit's. null where the
 * cgroup cannot be read; the caller compares two readings.
 */
export async function oomKills(extName: string): Promise<number | null> {
  if (process.env.ZVELTIO_EXT_RUNNER_SOCKET) return readOomKills('/sys/fs/cgroup/memory.events');
  try {
    const proc = Bun.spawn(
      ['systemctl', 'show', '-p', 'ControlGroup', '--value', runnerUnit(extName)],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const cg = (await new Response(proc.stdout).text()).trim();
    return cg ? readOomKills(join('/sys/fs/cgroup', cg, 'memory.events')) : null;
  } catch {
    return null;
  }
}

async function systemctl(verb: string, ...args: string[]): Promise<string> {
  // env: the PATH of now, not of the process's start.
  const proc = Bun.spawn(['systemctl', '--no-ask-password', verb, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`systemctl ${verb} ${args.join(' ')}: ${err.trim() || `exit ${code}`}`);
  return out;
}

/**
 * Start burst (ADR 0062 step 2b). A unit's `CPUQuota=20%` per 100 ms period
 * stretched a cold start's ~105 ms of CPU to ~0.5 s. A unit started from down
 * gets a 1 s period for `START_BURST_MS` after its start returns: the same 20%,
 * but its first 200 ms of CPU run unthrottled. Then the engine puts the 100 ms
 * period back, so a loop costs the engine what it did (step 1a).
 *
 * The engine sets it (`systemctl set-property --runtime`, polkit rule), not
 * the runner: on a unit the runner and the extension's process share one uid,
 * so whatever the runner could lower, the extension could raise again.
 * The period and not the quota: the share never changes, an operator's
 * `CPUQuota=` stays theirs, and a burst the engine never ends (it died in the
 * window) is still 20% of a core. A unit found running in its burst with no end
 * pending here is ended before it is handed a channel; a burst that cannot be
 * ended stops the unit.
 */
export const START_BURST_MS = 250;
const BURST_PERIOD = '1s';
const burstsPending = new Map<string, number>();
let burstRefused = false;

async function endBurst(unit: string): Promise<boolean> {
  try {
    await systemctl('set-property', '--runtime', unit, 'CPUQuotaPeriodSec=');
    return true;
  } catch (err) {
    console.error(`[ext-runner] ${(err as Error).message}; stopping ${unit} instead`);
    await systemctl('stop', unit).catch((e: Error) => console.error(`[ext-runner] ${e.message}`));
    return false;
  }
}

/** `systemctl start` a runner unit, with the start burst when it was down. */
export async function startUnit(unit: string, burstMs = START_BURST_MS): Promise<void> {
  const shown = await systemctl('show', '-p', 'ActiveState', '-p', 'CPUQuotaPeriodUSec', unit);
  const prop = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(shown)?.[1];
  if (prop('ActiveState') === 'active') {
    if (prop('CPUQuotaPeriodUSec') === BURST_PERIOD && !burstsPending.has(unit)) {
      if (!(await endBurst(unit))) throw new Error(`${unit} was left in its start burst`);
    }
    return;
  }
  // Down: nothing of the extension runs in it, so the burst covers only this
  // start. Sent beside the start, not before it: the first 20 ms of CPU are
  // under the cap either way.
  const lifted = systemctl(
    'set-property',
    '--runtime',
    unit,
    `CPUQuotaPeriodSec=${BURST_PERIOD}`,
  ).then(
    () => true,
    (err: Error) => {
      // A polkit rule written before the burst: starts stay capped, and slow.
      if (!burstRefused)
        console.warn(
          `[ext-runner] no start burst (re-run \`zveltio ext-runner setup\`): ${err.message}`,
        );
      burstRefused = true;
      return false;
    },
  );
  const started = systemctl('start', unit);
  if (!(await lifted)) {
    await started;
    return;
  }
  burstsPending.set(unit, (burstsPending.get(unit) ?? 0) + 1);
  try {
    await started;
  } finally {
    setTimeout(() => {
      const left = (burstsPending.get(unit) ?? 1) - 1;
      if (left > 0) burstsPending.set(unit, left);
      else burstsPending.delete(unit);
      void endBurst(unit);
    }, burstMs);
  }
}

/**
 * Start the extension's runner and return its socket once it listens. The
 * unit is `Type=notify` (`notifyReady`), so `systemctl start` returns with the
 * socket in place and the loop below ends at its first look; it waits only on a
 * `Type=simple` unit an older `setup` wrote.
 */
export function startRunner(extName: string): Promise<string> {
  return startInstance(runnerInstance(extName), true);
}

async function startInstance(instance: string, burst = false): Promise<string> {
  // Containers (RFC step 4): one runner service listens on a socket shared
  // with the engine; there is no systemd to start an instance.
  const shared = process.env.ZVELTIO_EXT_RUNNER_SOCKET;
  if (shared) return shared;
  const missing = runnerMissing();
  if (missing) throw new Error(missing);
  const unit = `zveltio-ext-runner@${instance}.service`;
  // The edge instance keeps its own period: one core shared by invocations.
  if (burst) await startUnit(unit);
  else await systemctl('start', unit);
  const path = join(RUNNER_DIR, instance, 'runner.sock');
  for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(100);
  if (!existsSync(path)) throw new Error(`${unit} started but ${path} did not appear in 10s`);
  return path;
}

export async function stopRunner(extName: string): Promise<void> {
  // The shared runner kills the extension's process when its connection closes.
  if (process.env.ZVELTIO_EXT_RUNNER_SOCKET) return;
  await systemctl('stop', runnerUnit(extName));
}

/**
 * Edge functions' runner (RFC step 5): the instance `edge`, which no extension
 * name can produce — `runnerInstance` always ends in `_<8 hex>`. Started once,
 * on the first invocation, and again after a failed one.
 */
export const EDGE_RUNNER_INSTANCE = 'edge';
/** First uid of the bare-metal edge instance's per-invocation range. */
export const EDGE_UID_BASE = 400_000;
let edgeSocket: Promise<string> | null = null;
export function edgeRunnerSocket(): Promise<string> {
  edgeSocket ??= startInstance(EDGE_RUNNER_INSTANCE);
  return edgeSocket;
}
export function forgetEdgeRunner(): void {
  edgeSocket = null;
}

// ── `zveltio ext-runner setup` ────────────────────────────────────────────

/**
 * The files `setup` writes, as text. One source for install.sh and update.sh
 * (which is downloaded on its own and cannot share a file with the installer).
 */
export function runnerSetupFiles(opts: {
  engineUser: string;
  engineUid: number;
  dir: string;
}): Record<string, string> {
  const { engineUser, engineUid, dir } = opts;
  return {
    '/etc/systemd/system/zveltio-ext-runner@.service': `# Written by \`zveltio ext-runner setup\`. One instance per extension; the engine
# starts it. Per-extension overrides: systemctl edit zveltio-ext-runner@<instance>
#   [Service]
#   MemoryMax=2G
# No IPAddressAllow: routes and actions have no egress (ADR 0022). Network work
# goes to a job that declares \`egress\`; the engine fetches for it.
[Unit]
Description=Zveltio extension runner (%i)
PartOf=zveltio.service
After=network.target

[Service]
# The runner says when it listens (sd_notify): \`systemctl start\` returns with
# the socket in place, and a runner that refuses to start fails the start at
# once (ADR 0062 step 2b). Only the runner itself may say so, not what it starts.
Type=notify
NotifyAccess=main
TimeoutStartSec=10
DynamicUser=yes
# Named per instance. Left to systemd, the name derives from the unit name, and
# two instances ended up as ONE uid — measured in CI: both runners ran as 63550
# and one wrote into the other's runner directory.
User=zx_%i
ExecStart=${dir}/zveltio ext-runner
Environment=NODE_ENV=production
Environment=ZVELTIO_ENGINE_UID=${engineUid}
Environment=ZVELTIO_EXT_RUNNER_SOCKET=${RUNNER_DIR}/%i/runner.sock
# Where the runner finds the Deno the engine downloaded for jobs (ADR 0023).
Environment=EXTENSIONS_DIR=${dir}/extensions
RuntimeDirectory=zveltio-ext/%i
RuntimeDirectoryMode=0755
Restart=on-failure
RestartSec=2
SyslogIdentifier=zveltio-ext-runner

# Only the binary and the Deno the engine downloads for jobs are visible from
# the engine's directory. No extension's files: the engine sends a bundle's
# bytes over the socket, so an extension cannot read another's (ADR 0062, F15).
TemporaryFileSystem=${dir}:ro
BindReadOnlyPaths=${dir}/zveltio -${dir}/extensions/${DENO_DIR_NAME}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
IPAddressDeny=any
# Seccomp, so it holds where IPAddressDeny (cgroup BPF) is a no-op. AF_UNIX
# for the runner's own socket; every process it starts loads the socket ban
# (ADR 0023), which refuses AF_UNIX too, and the runner checks at start that
# such a process opens no family at all.
RestrictAddressFamilies=AF_UNIX
# AF_UNIX stays for the runner; hide the host's sockets from it: abstract ones
# live in the network namespace, path sockets of D-Bus and Postgres are hidden.
PrivateNetwork=yes
InaccessiblePaths=-/run/dbus -/run/postgresql -/var/run/postgresql -/run/systemd/private
SystemCallArchitectures=native
SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register
# Refused with EPERM, not killed: the runner's start check probes io_uring.
SystemCallErrorNumber=EPERM

MemoryMax=1G
MemorySwapMax=0
TasksMax=64
# CPU (ADR 0062, F20): a loop in an extension spun a whole core and cost the
# engine +36-78% on its p95 on 2 vCPUs. A priority alone did not help (weight
# 10, idle, SCHED_IDLE: +53-77%, measured); the cap does: 20% of one core cost
# +11-13%, 10% nothing. The weight gives the engine the CPU first on a saturated
# host. The engine kills a process that spins past a call's deadline (30 s).
# A unit the engine starts from down runs its first 250 ms with a 1 s period
# (the start burst, ADR 0062 step 2b): same 20%, its first 200 ms unthrottled.
CPUWeight=10
CPUQuota=20%

[Install]
WantedBy=multi-user.target
`,
    [`/etc/systemd/system/zveltio-ext-runner@${EDGE_RUNNER_INSTANCE}.service.d/edge.conf`]: `# Written by \`zveltio ext-runner setup\`: edge functions and flow scripts
# run here, one process per invocation and several at once — a Bun process is
# about ten tasks, so the template's 64 would cap them near six.
# Each invocation under a uid of its own (ADR 0058, owner 2026-11-17): the
# runner starts as root with only CAP_SETUID, CAP_SETGID and CAP_KILL and drops
# each invocation to a uid from ${EDGE_UID_BASE} up (65536 of them). The range
# avoids systemd's dynamic users (61184-65519), the usual /etc/subuid start
# (100000) and container ranges (524288+). One shared uid would let a function
# read or kill another tenant's invocation while it runs.
[Service]
TasksMax=512
# One core for every invocation together; each ends at its own timeout.
CPUQuota=100%
DynamicUser=no
User=root
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL
AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_KILL
Environment=ZVELTIO_EXT_RUNNER_UID_BASE=${EDGE_UID_BASE}
`,
    '/etc/systemd/system/zveltio.service.d/ext-runner.conf': `# Written by \`zveltio ext-runner setup\`: worker-isolated extensions run in
# zveltio-ext-runner@ instances. .env can override it (EnvironmentFile wins).
[Service]
Environment=ZVELTIO_EXT_TRANSPORT=runner
`,
    '/etc/polkit-1/rules.d/50-zveltio-ext-runner.rules': `// Written by \`zveltio ext-runner setup\`: the engine user may start, stop
// and restart its extension runners, and no other unit. set-property: the
// engine gives a unit started from down its start burst and ends it (ADR 0062
// step 2b), as a runtime property, never written under /etc.
polkit.addRule(function (action, subject) {
  if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === ${JSON.stringify(engineUser)}) {
    var unit = action.lookup("unit") || "";
    var verb = action.lookup("verb");
    if (unit.indexOf("zveltio-ext-runner@") === 0 &&
        (verb === "start" || verb === "stop" || verb === "restart" || verb === "set-property")) {
      return polkit.Result.YES;
    }
  }
});
`,
  };
}

/** `zveltio ext-runner setup --engine-user <user> --dir <dir>`, as root. */
export function setupRunner(args: string[]): void {
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const engineUser = arg('--engine-user');
  const dir = arg('--dir');
  if (!engineUser || !dir || !/^[a-z_][a-z0-9_-]*$/.test(engineUser) || !dir.startsWith('/')) {
    console.error('usage: zveltio ext-runner setup --engine-user <user> --dir <absolute dir>');
    process.exit(2);
  }
  const id = Bun.spawnSync(['id', '-u', engineUser]);
  const engineUid = Number.parseInt(id.stdout.toString(), 10);
  if (id.exitCode !== 0 || !Number.isInteger(engineUid)) {
    console.error(`[ext-runner] no such user: ${engineUser}`);
    process.exit(1);
  }
  for (const [path, text] of Object.entries(runnerSetupFiles({ engineUser, engineUid, dir }))) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
    console.log(`[ext-runner] wrote ${path}`);
  }
  // The units bind it at start: made now, the engine's, so a Deno it downloads
  // later shows in units already running.
  const deno = join(dir, 'extensions', DENO_DIR_NAME);
  if (!existsSync(deno)) {
    mkdirSync(deno, { recursive: true, mode: 0o755 });
    Bun.spawnSync(['chown', `${engineUser}:`, join(dir, 'extensions'), deno]);
  }
}

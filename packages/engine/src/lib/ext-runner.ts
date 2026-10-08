/**
 * `zveltio ext-runner` — the bare-metal extension runner (RFC
 * extension-runner, step 3).
 *
 * A separate systemd service, started as the `zveltio-ext` user the installer
 * creates. The engine keeps `NoNewPrivileges=yes` and so cannot start a process
 * under another uid itself; it connects here instead. Each accepted connection
 * gets one runtime process, spawned under the runner's uid, and the
 * connection's bytes are piped to that process's stdin/stdout unchanged — the
 * #979 frames, which only the engine and the runtime decode. A closed
 * connection kills the process; an exited process closes the connection.
 *
 * What makes it a boundary: the runtime runs under a uid that cannot read the
 * engine's files (`.env`, storage) or its process state (`/proc/<pid>/environ`
 * is owner-only), and it holds no database connection — `db:query` still
 * crosses to the engine. The unit adds cgroup limits and the egress rule.
 *
 * Who may connect: only the engine's uid, read from the kernel with
 * SO_PEERCRED. The runtimes run under the runner's uid, so without that check
 * an extension could ask for more processes; with it, only the engine can.
 */

import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { WORKER_RUNTIME_SOURCE } from './worker-extension-runtime-source.generated.js';
import { runnerSocketPath } from './worker-extension-transport.js';

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
 * a refusal. Bun exposes neither the option nor a way to listen on a socket
 * systemd created, so it is one libc call through `bun:ffi`.
 */
type Getsockopt = (fd: number, level: number, name: number, val: unknown, len: unknown) => number;
let getsockopt: Getsockopt | null = null;
async function peerUid(socket: Socket): Promise<number | null> {
  // biome-ignore lint/suspicious/noExplicitAny: Bun keeps the descriptor on the internal handle
  const fd = (socket as any)._handle?.fd;
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

/**
 * Address space per runtime, in MiB. Bun does not start under ~1 GiB of
 * RLIMIT_AS (see edge-functions/subprocess-runner.ts), so that is the floor and
 * the default; the unit's MemoryMax bounds all runtimes together.
 */
function memoryLimitMb(): number {
  const parsed = Number.parseInt(process.env.ZVELTIO_EXT_MEMORY_MB ?? '', 10);
  return Number.isFinite(parsed) && parsed > 1024 ? parsed : 1024;
}

export async function runExtRunner(): Promise<never> {
  const engineUid = Number.parseInt(process.env.ZVELTIO_ENGINE_UID ?? '', 10);
  if (!Number.isInteger(engineUid) || engineUid < 0) {
    console.error('[ext-runner] ZVELTIO_ENGINE_UID must be the numeric uid of the engine service');
    process.exit(1);
  }
  // Same uid as the engine = no boundary at all. Refuse rather than run as
  // a slower in-process worker that looks isolated.
  const ownUid = process.getuid?.();
  if (ownUid === undefined || ownUid === engineUid || ownUid === 0) {
    console.error(
      '[ext-runner] refusing to run as the engine uid or as root — start it as zveltio-ext',
    );
    process.exit(1);
  }

  const runtimePath = ensureWorkerRuntimeOnDisk();
  const limitKb = memoryLimitMb() * 1024;
  // Only what the runtime needs. The runner's own environment is the unit's,
  // and nothing of the engine's ever reaches this process.
  const childEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', BUN_BE_BUN: '1' };

  const server = createServer(async (conn) => {
    const uid = await peerUid(conn).catch(() => null);
    if (uid !== engineUid) {
      console.warn(`[ext-runner] refused a connection from uid ${uid ?? 'unknown'}`);
      conn.destroy();
      return;
    }
    // `ulimit` through a shell that then `exec`s the runtime: Bun cannot call
    // setrlimit itself. The paths are positional arguments, never quoted.
    const child = spawn(
      '/bin/sh',
      ['-c', `ulimit -v ${limitKb} 2>/dev/null; exec "$0" "$1"`, process.execPath, runtimePath],
      { stdio: ['pipe', 'pipe', 'inherit'], env: childEnv },
    );
    conn.pipe(child.stdin);
    child.stdout.pipe(conn);
    conn.on('close', () => child.kill('SIGKILL'));
    conn.on('error', () => child.kill('SIGKILL'));
    child.stdin.on('error', () => conn.destroy());
    child.on('exit', () => conn.destroy());
  });

  const path = runnerSocketPath();
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  // Anyone may reach connect(); SO_PEERCRED decides who is served.
  chmodSync(path, 0o666);
  console.log(`[ext-runner] listening on ${path} for uid ${engineUid}`);

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return new Promise<never>(() => {});
}

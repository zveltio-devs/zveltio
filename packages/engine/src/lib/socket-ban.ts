/**
 * The kernel socket ban (ADR 0023): the seccomp filter every process the
 * runner starts is loaded with (`socketBanned`), and the check the runner
 * makes before it serves anything.
 *
 * An allowlist on the socket calls, not a deny-list of families: `socket(AF_SMC)`
 * falls back to TCP and reached 1.1.1.1 past a filter that refused only the
 * INET families (measured). So:
 *   - `socket` and `io_uring_setup/enter/register` fail with EACCES for every
 *     family (io_uring opens sockets of its own);
 *   - `socketpair` fails the same way except for AF_UNIX SOCK_STREAM: a
 *     connected stream pair inside the process reaches nothing outside it (a
 *     datagram pair would: `sendto` with an address reaches the host's
 *     datagram sockets, `/dev/log` or an abstract one), and the runtimes need one
 *     (Deno's tokio signal self-pipe panics without it; Bun pipes a child's
 *     stdio through one — measured);
 *   - on x86_64, the x32 range (`nr | 0x40000000`) fails the same way;
 *   - any other architecture (i386, AArch32, whose socketcall the numbers
 *     below do not cover) kills the process.
 * The process needs no socket: its channel to the engine is fds 0-2, created
 * by the runner before exec.
 *
 * Built here from this table rather than shipped as bytes, so the review is of
 * the table. A `struct sock_filter` is { u16 code, u8 jt, u8 jf, u32 k },
 * little-endian on both architectures.
 */

import { fileURLToPath } from 'node:url';
import { runningAsCompiledBinary } from './edge-functions/runner-sentinel.js';

// linux/audit.h
const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 } as const;
// socket, io_uring_setup, io_uring_enter, io_uring_register
const DENIED_NR = { x64: [41, 425, 426, 427], arm64: [198, 425, 426, 427] } as const;
// socketpair: allowed for AF_UNIX SOCK_STREAM only
const SOCKETPAIR_NR = { x64: 53, arm64: 199 } as const;
const AF_UNIX = 1;
const SOCK_STREAM = 1;
// The type's low bits; SOCK_NONBLOCK and SOCK_CLOEXEC sit above them.
const SOCK_TYPE_MASK = 0xf;
const X32_SYSCALL_BIT = 0x40000000;

// linux/filter.h, linux/seccomp.h
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const AND_K = 0x54;
const RET_K = 0x06;
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
// args[0], low 32 bits (little-endian): the family is an int
const SECCOMP_DATA_ARG0 = 16;
const SECCOMP_DATA_ARG1 = 24;
const RET_KILL_PROCESS = 0x80000000;
const RET_EACCES = 0x00050000 | 13;
const RET_ALLOW = 0x7fff0000;

export function socketBanFilter(arch: string = process.arch): Uint8Array {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`no seccomp socket ban for architecture ${arch}`);
  }
  const deny = [RET_K, 0, 0, RET_EACCES] as const;
  const prog: (readonly [number, number, number, number])[] = [
    [LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH],
    [JEQ_K, 1, 0, AUDIT_ARCH[arch]],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, SECCOMP_DATA_NR],
  ];
  if (arch === 'x64') prog.push([JGE_K, 0, 1, X32_SYSCALL_BIT], deny);
  for (const nr of DENIED_NR[arch]) prog.push([JEQ_K, 0, 1, nr], deny);
  prog.push(
    [JEQ_K, 0, 7, SOCKETPAIR_NR[arch]],
    [LD_W_ABS, 0, 0, SECCOMP_DATA_ARG0],
    [JEQ_K, 0, 4, AF_UNIX],
    [LD_W_ABS, 0, 0, SECCOMP_DATA_ARG1],
    [AND_K, 0, 0, SOCK_TYPE_MASK],
    [JEQ_K, 0, 1, SOCK_STREAM],
    [RET_K, 0, 0, RET_ALLOW],
    deny,
  );
  prog.push([RET_K, 0, 0, RET_ALLOW]);
  const out = new DataView(new ArrayBuffer(prog.length * 8));
  prog.forEach(([code, jt, jf, k], i) => {
    out.setUint16(i * 8, code, true);
    out.setUint8(i * 8 + 2, jt);
    out.setUint8(i * 8 + 3, jf);
    out.setUint32(i * 8 + 4, k, true);
  });
  return new Uint8Array(out.buffer);
}

/** The argument that makes this binary load the filter into itself and exec the rest. */
export const SOCKET_BAN_SENTINEL = '__socket-ban-exec';
/** The environment the banned process gets, carried past the loader as JSON. */
const EXEC_ENV = 'ZVELTIO_SOCKET_BAN_ENV';

/**
 * What the runner spawns instead of `argv`, `env`: this binary under
 * SOCKET_BAN_SENTINEL (`binary-entry.ts`), which loads the filter and execs
 * `argv` with exactly `env`. The runner's own process keeps AF_UNIX for its
 * socket; everything it starts runs under the filter, containers and systemd
 * alike. Not `setpriv --seccomp-filter`: the bare-metal hosts (Ubuntu 22.04
 * and 24.04, Debian 11 and 12) ship util-linux older than 2.41.
 * No BUN_BE_BUN here: it would turn the binary into plain `bun`, which never
 * reads the sentinel. Running from source, `bun binary-entry.ts` reaches it.
 */
export function socketBanned(
  argv: string[],
  env: Record<string, string>,
): { argv: string[]; env: Record<string, string> } {
  const entry = runningAsCompiledBinary()
    ? []
    : [fileURLToPath(new URL('../binary-entry.ts', import.meta.url))];
  return {
    argv: [process.execPath, ...entry, SOCKET_BAN_SENTINEL, ...argv],
    env: {
      [EXEC_ENV]: JSON.stringify(env),
      // To find argv[0] as spawn did: the child's PATH, else the runner's.
      PATH: env.PATH ?? process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin',
    },
  };
}

/**
 * The SOCKET_BAN_SENTINEL side: no_new_privs, the filter on this thread (the
 * one that execs, so nothing of this process outlives it unbanned), then
 * execve. Returns only by exiting 126 with the reason.
 */
export async function execUnderSocketBan(argv: string[]): Promise<never> {
  const fail = (why: string): never => {
    console.error(`[socket-ban] ${why}`);
    process.exit(126);
  };
  const env = JSON.parse(process.env[EXEC_ENV] ?? 'null') as Record<string, string> | null;
  if (!env || !argv[0]) return fail(`usage: ${SOCKET_BAN_SENTINEL} <argv...> with ${EXEC_ENV}`);
  const file = argv[0].includes('/') ? argv[0] : Bun.which(argv[0]);
  if (!file) return fail(`${argv[0]}: not found`);
  const { dlopen, FFIType: T, ptr } = await import('bun:ffi');
  const { symbols: c } = dlopen('libc.so.6', {
    prctl: { args: [T.i32, T.u64, T.u64, T.u64, T.u64], returns: T.i32 },
    execve: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  });
  // Every buffer a pointer names stays referenced until execve.
  const keep: ArrayBufferView[] = [];
  const cstr = (s: string) => {
    const b = Buffer.from(`${s}\0`);
    keep.push(b);
    return BigInt(ptr(b));
  };
  const list = (xs: string[]) => {
    const v = new BigUint64Array([...xs.map(cstr), 0n]);
    keep.push(v);
    return ptr(v);
  };
  const prog = socketBanFilter();
  // struct sock_fprog { u16 len; struct sock_filter *filter; }
  const fprog = new BigUint64Array([BigInt(prog.length / 8), BigInt(ptr(prog))]);
  const PR_SET_SECCOMP = 22;
  const PR_SET_NO_NEW_PRIVS = 38;
  const SECCOMP_MODE_FILTER = 2;
  if (c.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) return fail('PR_SET_NO_NEW_PRIVS failed');
  if (c.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, BigInt(ptr(fprog)), 0, 0) !== 0) {
    return fail('the kernel refused the seccomp filter');
  }
  const path = Buffer.from(`${file}\0`);
  c.execve(path, list(argv), list(Object.entries(env).map(([k, v]) => `${k}=${v}`)));
  return fail(`execve ${file} failed`);
}

/**
 * What the check runs under the wrap: one `socket()` per family through libc,
 * printed as the descriptor, or -1 with errno. AF_SMC is the one a deny-list
 * missed; AF_UNIX is the one systemd's RestrictAddressFamilies leaves the
 * runner, and so tells the filter from the unit alone.
 */
export const SOCKET_BAN_PROBE = `const { dlopen, FFIType, ptr, read } = require('bun:ffi');
const { symbols: c } = dlopen('libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i64 },
  __errno_location: { returns: FFIType.ptr },
});
const out = {};
for (const [name, family] of [['AF_INET', 2], ['AF_INET6', 10], ['AF_SMC', 43], ['AF_UNIX', 1]]) {
  const fd = c.socket(family, 1, 0);
  out[name] = fd >= 0 ? 'fd ' + fd : 'errno ' + read.i32(c.__errno_location(), 0);
}
// io_uring_setup (425 on x86_64 and aarch64) with valid params: IORING_OP_SOCKET
// opens sockets past a socket() ban, and systemd ignores an unknown filter name.
const ring = Number(c.syscall(425, 1, ptr(new Uint8Array(120))));
out.io_uring = ring >= 0 ? 'fd ' + ring : 'errno ' + read.i32(c.__errno_location(), 0);
console.log(JSON.stringify(out));`;

type Wrap = (
  argv: string[],
  opts: { env: Record<string, string> },
) => { argv: string[]; env?: Record<string, string>; release?: () => void };
type SpawnSync = (
  argv: string[],
  env: Record<string, string>,
) => { exitCode: number | null; stdout: Buffer; stderr?: Buffer };

/**
 * Run `SOCKET_BAN_PROBE` through the runner's own wrap, the way a runtime
 * starts; the refusal, or null when no family opened. Only the wrap's filter
 * refuses AF_UNIX (EACCES); the others may also meet the unit's
 * RestrictAddressFamilies first (EAFNOSUPPORT): a failure is a failure
 * whatever its errno. No warning-only mode: a runner that cannot ban sockets
 * serves nothing (ADR 0023 decision 3).
 */
export function checkSocketBan(
  wrap: Wrap,
  run: SpawnSync = (argv, env) => Bun.spawnSync(argv, { stderr: 'pipe', cwd: '/', env }),
): string | null {
  // bun:ffi needs the JIT, which JSC turns off when its default executable
  // reservation does not fit the wrap's RLIMIT_AS (measured: "bun:ffi
  // requires the JIT" under 1024 MB). Ignored by a Bun that drops the
  // option: the probe then fails, and the runner refuses to start.
  const probeEnv = {
    BUN_BE_BUN: '1',
    BUN_JSC_jitMemoryReservationSize: String(64 << 20),
    // The wrap's argv[0] is prlimit/setpriv, resolved from PATH.
    PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin',
  };
  const { argv, env, release } = wrap([process.execPath, '-e', SOCKET_BAN_PROBE], {
    env: probeEnv,
  });
  let r: ReturnType<SpawnSync>;
  try {
    r = run(argv, env ?? probeEnv);
  } finally {
    release?.();
  }
  let got: Record<string, string> | null = null;
  try {
    got = JSON.parse(r.stdout.toString().trim().split('\n').at(-1) ?? '');
  } catch {
    /* reported below */
  }
  const opened = got ? Object.entries(got).filter(([, v]) => !v.startsWith('errno ')) : [];
  if (r.exitCode === 0 && got && Object.keys(got).length === 5 && opened.length === 0) return null;
  const why = got
    ? opened.map(([family, v]) => `${family}: ${v}`).join(', ')
    : r.stderr?.toString().trim() || `exit ${r.exitCode}`;
  return (
    `the runner cannot ban sockets for the processes it starts (${why}): ` +
    'the runner loads the filter through bun:ffi (glibc libc.so.6) and prctl(PR_SET_SECCOMP), ' +
    'which the kernel must allow (CONFIG_SECCOMP_FILTER)'
  );
}

/**
 * The kernel socket ban (ADR 0023): the seccomp filter every process the
 * container runner starts is loaded with (`setpriv --seccomp-filter`), and the
 * check the runner makes before it serves anything.
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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Container mode: the filter on disk for setpriv, which reads it as root
 * before the uid drop (measured: a 0600 file works), so in a directory only
 * root (the runner) can reach.
 */
export function writeSocketBan(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'zveltio-seccomp-')), 'socket-ban.bpf');
  writeFileSync(path, socketBanFilter(), { mode: 0o600 });
  return path;
}

/**
 * What the check runs under the wrap: one `socket()` per family through libc,
 * printed as the descriptor, or -1 with errno. AF_SMC is the one a deny-list
 * missed.
 */
export const SOCKET_BAN_PROBE = `const { dlopen, FFIType, ptr, read } = require('bun:ffi');
const { symbols: c } = dlopen('libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i64 },
  __errno_location: { returns: FFIType.ptr },
});
const out = {};
for (const [name, family] of [['AF_INET', 2], ['AF_INET6', 10], ['AF_SMC', 43]]) {
  const fd = c.socket(family, 1, 0);
  out[name] = fd >= 0 ? 'fd ' + fd : 'errno ' + read.i32(c.__errno_location(), 0);
}
// io_uring_setup (425 on x86_64 and aarch64) with valid params: IORING_OP_SOCKET
// opens sockets past a socket() ban, and systemd ignores an unknown filter name.
const ring = Number(c.syscall(425, 1, ptr(new Uint8Array(120))));
out.io_uring = ring >= 0 ? 'fd ' + ring : 'errno ' + read.i32(c.__errno_location(), 0);
console.log(JSON.stringify(out));`;

type Wrap = (argv: string[]) => { argv: string[]; release?: () => void };
type SpawnSync = (argv: string[]) => { exitCode: number | null; stdout: Buffer; stderr?: Buffer };

/**
 * Run `SOCKET_BAN_PROBE` through the runner's own wrap, the way a runtime
 * starts; the refusal, or null when no family opened. Containers ban sockets
 * through the wrap's filter (EACCES), systemd through the unit's
 * RestrictAddressFamilies, which the probe inherits (EAFNOSUPPORT); a failure
 * is a failure whatever its errno. No warning-only mode: a runner that cannot
 * ban sockets serves nothing (ADR 0023 decision 3).
 */
export function checkSocketBan(
  wrap: Wrap,
  run: SpawnSync = (argv) =>
    Bun.spawnSync(argv, {
      stderr: 'pipe',
      cwd: '/',
      // bun:ffi needs the JIT, which JSC turns off when its default executable
      // reservation does not fit the wrap's RLIMIT_AS (measured: "bun:ffi
      // requires the JIT" under 1024 MB). Ignored by a Bun that drops the
      // option: the probe then fails, and the runner refuses to start.
      env: {
        BUN_BE_BUN: '1',
        BUN_JSC_jitMemoryReservationSize: String(64 << 20),
        // The wrap's argv[0] is prlimit/setpriv, resolved from PATH.
        PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin',
      },
    }),
): string | null {
  const { argv, release } = wrap([process.execPath, '-e', SOCKET_BAN_PROBE]);
  let r: ReturnType<SpawnSync>;
  try {
    r = run(argv);
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
  if (r.exitCode === 0 && got && Object.keys(got).length === 4 && opened.length === 0) return null;
  const why = got
    ? opened.map(([family, v]) => `${family}: ${v}`).join(', ')
    : r.stderr?.toString().trim() || `exit ${r.exitCode}`;
  return (
    `the runner cannot ban sockets for the processes it starts (${why}): ` +
    'in a container the runner needs setpriv with --seccomp-filter (util-linux 2.41 or newer); ' +
    'on systemd its unit needs RestrictAddressFamilies=AF_UNIX (zveltio ext-runner setup writes it)'
  );
}

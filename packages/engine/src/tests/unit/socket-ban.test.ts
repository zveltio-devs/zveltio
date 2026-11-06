// ADR 0023: the seccomp filter the container runner loads into every process
// it starts. Loaded here into a real Bun process (prctl + seccomp(2) through
// bun:ffi, as setpriv does; CI's setpriv predates --seccomp-filter), which
// then tries what hostile extension code would, and what a runtime must still
// do. Each check also runs without the filter: the control that this host
// opens what the filter has to refuse.
import { describe, expect, it } from 'bun:test';
import { checkSocketBan, socketBanFilter } from '../../lib/socket-ban.js';

const loader = (filter: Uint8Array | null) =>
  filter === null
    ? ''
    : `{
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const { symbols: l } = dlopen('libc.so.6', {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i64 },
  });
  globalThis.__prog = Buffer.from(${JSON.stringify(Buffer.from(filter).toString('base64'))}, 'base64');
  const fprog = new BigUint64Array([BigInt(__prog.length / 8), BigInt(ptr(__prog))]);
  if (l.prctl(38, 1, 0, 0, 0) !== 0) throw new Error('PR_SET_NO_NEW_PRIVS');
  // seccomp(SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC): every thread.
  if (Number(l.syscall(process.arch === 'x64' ? 317 : 277, 1, 1, ptr(fprog))) !== 0) throw new Error('seccomp');
}
`;

// What hostile code tries, and what the runtime needs, as one JSON line.
const attempts = `
const { dlopen, FFIType, read, ptr } = require('bun:ffi');
const { symbols: c } = dlopen('libc.so.6', {
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  __errno_location: { returns: FFIType.ptr },
});
const errno = () => read.i32(c.__errno_location(), 0);
const out = {};
const fds = new Int32Array(2);
out.socketpair = c.socketpair(1, 1, 0, ptr(fds)) === 0 ? 'ok' : 'errno ' + errno();
out.socketpairInet = c.socketpair(2, 1, 0, ptr(fds)) === 0 ? 'ok' : 'errno ' + errno();
// SOCK_DGRAM: sendto with an address would reach the host's datagram sockets.
out.socketpairDgram = c.socketpair(1, 2, 0, ptr(fds)) === 0 ? 'ok' : 'errno ' + errno();
// SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, as tokio asks.
out.socketpairFlags = c.socketpair(1, 1 | 0o4000 | 0o2000000, 0, ptr(fds)) === 0 ? 'ok' : 'errno ' + errno();
// x32 getpid (39 | 0x40000000) and io_uring_setup(1, NULL).
if (process.arch === 'x64') out.x32 = Number(c.syscall(39 | 0x40000000, 0, 0, 0)) >= 0 ? 'ok' : 'errno ' + errno();
out.io_uring = Number(c.syscall(425, 1, 0, 0)) >= 0 ? 'ok' : 'errno ' + errno();
out.net = await new Promise((r) => {
  const s = require('node:net').connect(9, '127.0.0.1');
  s.on('connect', () => { s.destroy(); r('connected'); });
  s.on('error', (e) => r(e.code));
});
// The runtime's own needs: a Worker, timers, crypto, a file, its stdin.
out.worker = await new Promise((r) => {
  const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage = (e) => postMessage(e.data * 2)'])));
  w.onmessage = (e) => { w.terminate(); r(e.data); };
  w.postMessage(21);
});
await Bun.sleep(5);
out.digest = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(1))).toString('hex').slice(0, 8);
out.file = (await Bun.file('/proc/self/status').text()).match(/Seccomp:\\s+(\\d)/)?.[1];
out.stdin = await Bun.stdin.text();
console.log(JSON.stringify(out));
`;

function runUnder(filter: Uint8Array | null): Record<string, unknown> {
  const r = Bun.spawnSync([process.execPath, '-e', loader(filter) + attempts], {
    stdin: Buffer.from('frame'),
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!);
}

// A classic-BPF interpreter for the four opcodes the filter uses, so the
// architecture this host is not (aarch64 on CI, or the reverse) is checked too.
function evaluate(prog: Uint8Array, arch: number, nr: number, arg0 = 0, arg1 = 0): number {
  const v = new DataView(prog.buffer, prog.byteOffset, prog.byteLength);
  const data: Record<number, number> = { 0: nr, 4: arch, 16: arg0, 24: arg1 };
  let a = 0;
  for (let pc = 0; ; pc++) {
    const [code, jt, jf, k] = [
      v.getUint16(pc * 8, true),
      v.getUint8(pc * 8 + 2),
      v.getUint8(pc * 8 + 3),
      v.getUint32(pc * 8 + 4, true),
    ];
    if (code === 0x20) a = data[k] ?? 0;
    else if (code === 0x15) pc += a === k ? jt : jf;
    else if (code === 0x35) pc += a >= k ? jt : jf;
    else if (code === 0x54) a = (a & k) >>> 0;
    else if (code === 0x06) return k;
    else throw new Error(`opcode ${code}`);
  }
}

const EACCES = 0x0005000d;
const ALLOW = 0x7fff0000;
const KILL = 0x80000000;

describe('socket ban filter, by architecture', () => {
  const cases = {
    x64: {
      audit: 0xc000003e,
      banned: [41, 425, 426, 427],
      socketpair: 53,
      allowed: [0, 1, 42, 43, 56, 59, 231],
    },
    arm64: {
      audit: 0xc00000b7,
      banned: [198, 425, 426, 427],
      socketpair: 199,
      allowed: [63, 64, 200, 203, 220, 221, 94],
    },
  } as const;
  for (const [arch, c] of Object.entries(cases)) {
    it(`${arch}: refuses socket, socketpair but AF_UNIX and io_uring, allows the rest, kills a foreign ABI`, () => {
      const prog = socketBanFilter(arch);
      for (const nr of c.banned) expect(evaluate(prog, c.audit, nr)).toBe(EACCES);
      for (const nr of c.allowed) expect(evaluate(prog, c.audit, nr)).toBe(ALLOW);
      // i386 and AArch32: socketcall(102) and socket(281) there are other numbers.
      expect(evaluate(prog, 0x40000003, 102)).toBe(KILL);
      expect(evaluate(prog, 0x40000028, 281)).toBe(KILL);
      if (arch === 'x64') expect(evaluate(prog, c.audit, 0x40000000 | 41)).toBe(EACCES);
      // socketpair: AF_UNIX only (Deno's tokio needs one; it reaches nothing).
      expect(evaluate(prog, c.audit, c.socketpair, 1, 1)).toBe(ALLOW);
      expect(evaluate(prog, c.audit, c.socketpair, 1, 1 | 0o4000 | 0o2000000)).toBe(ALLOW);
      for (const type of [2, 3, 5])
        expect(evaluate(prog, c.audit, c.socketpair, 1, type)).toBe(EACCES);
      for (const family of [2, 10, 16, 43]) {
        expect(evaluate(prog, c.audit, c.socketpair, family, 1)).toBe(EACCES);
      }
    });
  }

  it('has no filter for an architecture it does not know', () => {
    expect(() => socketBanFilter('ia32')).toThrow('no seccomp socket ban');
  });
});

describe.skipIf(process.platform !== 'linux')('socket ban, loaded into a Bun process', () => {
  it('without it, this host opens every one of them (control)', () => {
    const got = runUnder(null);
    expect(got.socketpair).toBe('ok');
    expect(got.net).not.toBe('EACCES');
    expect(got.io_uring).not.toBe('errno 13');
    if (process.arch === 'x64') expect(got.x32).not.toBe('errno 13');
    expect(got.file).toBe('0');
  });

  it('refuses every socket and leaves the runtime working', () => {
    const got = runUnder(socketBanFilter());
    expect(got).toEqual({
      socketpair: 'ok',
      socketpairInet: 'errno 13',
      socketpairDgram: 'errno 13',
      socketpairFlags: 'ok',
      ...(process.arch === 'x64' ? { x32: 'errno 13' } : {}),
      io_uring: 'errno 13',
      net: 'EACCES',
      worker: 42,
      digest: '6e340b9c',
      file: '2',
      stdin: 'frame',
    });
  });
});

describe.skipIf(process.platform !== 'linux')('checkSocketBan', () => {
  const under =
    (filter: Uint8Array | null) =>
    (argv: string[]): { argv: string[] } => ({
      argv: [argv[0]!, argv[1]!, loader(filter) + argv[2]!],
    });

  it('passes a wrap that bans AF_INET, AF_INET6 and AF_SMC', () => {
    expect(checkSocketBan(under(socketBanFilter()))).toBeNull();
  });

  it('refuses a wrap that bans nothing, naming what opened', () => {
    const refused = checkSocketBan(under(null));
    expect(refused).toContain('AF_INET: fd');
    expect(refused).toContain('AF_SMC: fd');
  });

  it('refuses a wrap that fails to start, and releases what it took', () => {
    let released = 0;
    const refused = checkSocketBan((argv) => ({
      argv: ['setpriv', '--no-such-flag', '--', ...argv],
      release: () => released++,
    }));
    expect(refused).toContain('cannot ban sockets');
    expect(released).toBe(1);
  });

  it('refuses output that names fewer families than it asked about', () => {
    const refused = checkSocketBan(
      (argv) => ({ argv }),
      () => ({ exitCode: 0, stdout: Buffer.from('{"AF_INET":"errno 13"}\n') }),
    );
    expect(refused).not.toBeNull();
  });
});

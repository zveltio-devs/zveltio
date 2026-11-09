/**
 * The Deno job runner (ADR 0022), against the real pinned Deno: what the child
 * is refused, how each ceiling ends a run, and that every call reaches the
 * engine only as a message `call` answers. Items 1 and 2 of the ADR's
 * "Verified in implementation" list. Every case runs twice: as the engine's
 * child (`process`), and across the extension runner (`runner`, ADR 0023
 * decision 2) — `routeConnection` on a socket in this process, the code
 * `zveltio ext-runner` serves with, minus the uid drop and the socket ban its
 * wrap adds (ext-runner-{standalone,compose,systemd}.sh prove those).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'bun';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeno, othersWritable, unzipSingle } from '../../lib/extensions/deno.js';
import {
  fromBase64Strict,
  RUNNER_BOOTSTRAP,
  RUNNER_LIMITS,
  jobPlacement,
  parseJobHeader,
  runInDeno,
  runnerAnswers,
  serveJobConnection,
  type HostCall,
} from '../../lib/extensions/job-runner.js';
import { routeConnection } from '../../lib/ext-runner.js';
import { deflateRawSync } from 'node:zlib';

let deno = '';
let transport: 'process' | 'runner' = 'process';
const sockDir = mkdtempSync(join(tmpdir(), 'zv-job-runner-test-'));
const sock = join(sockDir, 'runner.sock');
let server: Server;
/** What the runner's wrap was asked for, per job connection. */
const wrapped: { argv: string[]; addressSpace?: boolean }[] = [];
let wrapThrows = false;
let released = 0;
const saved = {
  transport: process.env.ZVELTIO_EXT_TRANSPORT,
  socket: process.env.ZVELTIO_EXT_RUNNER_SOCKET,
  env: process.env.NODE_ENV,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const code = (src: string) => new TextEncoder().encode(src);
const job = (body: string) => code(`export default { j: async (input, host) => { ${body} } };`);

async function run(
  src: Uint8Array,
  opts: {
    call?: (n: HostCall, a: unknown[]) => Promise<unknown>;
    memoryMb?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  try {
    process.env.ZVELTIO_EXT_TRANSPORT = transport;
    await runInDeno({
      extName: 'acme/jobs',
      deno,
      code: src,
      job: 'j',
      input: { n: 1 },
      timezone: 'Europe/Bucharest',
      memoryMb: opts.memoryMb ?? 64,
      timeoutSeconds: opts.timeoutSeconds ?? 10,
      signal: opts.signal,
      call: opts.call ?? (async () => null),
    });
    return 'ok';
  } catch (err) {
    return (err as Error).message;
  }
}

beforeAll(async () => {
  deno = await ensureDeno();
  server = createServer((conn) =>
    routeConnection(conn, {
      // An extension's channel is piped to its program unchanged; `cat` echoes it.
      workerArgv: ['cat'],
      childEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      wrap: (argv, opts) => {
        wrapped.push({ argv, addressSpace: opts?.addressSpace });
        if (wrapThrows) throw new Error('setpriv: not found');
        return { argv, release: () => void released++ };
      },
      serveEdge: (c) => c.destroy(),
      serveJob: (c, first, wrap) => serveJobConnection(c, first, wrap, async () => deno),
    }),
  );
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  process.env.ZVELTIO_EXT_RUNNER_SOCKET = sock;
}, 120_000);

afterAll(async () => {
  restore('ZVELTIO_EXT_TRANSPORT', saved.transport);
  restore('ZVELTIO_EXT_RUNNER_SOCKET', saved.socket);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(sockDir, { recursive: true, force: true });
});

for (const t of ['process', 'runner'] as const) {
  describe(`over ${t}`, () => {
    beforeAll(() => {
      transport = t;
    });

    describe('a job in Deno reaches nothing but the engine', () => {
      const refused: [string, string, RegExp][] = [
        ['fetch to any host', `await fetch('https://example.com');`, /Requires net access/],
        [
          'a raw socket',
          `await Deno.connect({ hostname: '127.0.0.1', port: 5432 });`,
          /Requires net access/,
        ],
        ['the environment', `Deno.env.get('DATABASE_URL');`, /Requires env access/],
        ['any read', `await Deno.readTextFile('/etc/passwd');`, /Requires read access/],
        ['a write', `await Deno.writeTextFile('x', 'x');`, /Requires write access/],
        ['a subprocess', `await new Deno.Command('/bin/sh').output();`, /Requires run access/],
        ['FFI', `Deno.dlopen('libc.so.6', {});`, /Requires ffi access/],
        [
          'a permission request',
          `const s = await Deno.permissions.request({ name: 'net' }); throw new Error('state ' + s.state);`,
          /state denied/,
        ],
        ['an https: import', `await import('https://deno.land/std/version.ts');`, /--no-remote/],
        ['an npm: import', `await import('npm:lodash');`, /--no-npm/],
        [
          'a worker granted more',
          `new Worker('data:text/javascript,1', { type: 'module', deno: { permissions: { net: true } } });`,
          /unstable-worker-options|Requires|NotCapable|escalat/i,
        ],
      ];
      for (const [what, body, why] of refused) {
        it(`refuses ${what}`, async () => {
          expect(await run(job(body))).toMatch(why);
        }, 20_000);
      }

      it('answers host calls, returns their errors with code and status, and logs to stderr', async () => {
        const seen: [string, unknown[]][] = [];
        const out = await run(
          job(`
        console.log('a log line is not a message');
        const row = await host.collections.read('c', 'id-1');
        if (row.v !== 1 || host.timezone !== 'Europe/Bucharest' || input.n !== 1) throw new Error('lost');
        try { await host.collections.insert('nope', {}); } catch (e) {
          if (e.code !== 'refused' || e.status !== 403) throw new Error('lost the code');
        }
        await host.collections.update('c', 'id-1', { v: 2 }, { expect: { v: [1] } });
      `),
          {
            call: async (n, a) => {
              seen.push([n, a]);
              if (a[0] === 'nope')
                throw Object.assign(new Error('no'), { code: 'refused', status: 403 });
              return { v: 1 };
            },
          },
        );
        expect(out).toBe('ok');
        expect(seen.map(([n]) => n)).toEqual([
          'collections.read',
          'collections.insert',
          'collections.update',
        ]);
        expect(seen[2]![1]).toEqual(['c', 'id-1', { v: 2 }, { expect: { v: [1] } }]);
      }, 20_000);

      it('fails a run that throws, naming why', async () => {
        expect(await run(job(`throw new Error('the remote said no');`))).toBe('the remote said no');
        expect(await run(code('export default {};'))).toMatch(/exports no job "j"/);
      }, 20_000);

      it('kills a run that writes anything but a message on the channel', async () => {
        expect(
          await run(
            job(
              `await Deno.stdout.write(new TextEncoder().encode('{"id":"x"}\\n')); await new Promise(() => {});`,
            ),
          ),
        ).toMatch(/malformed host call/);
      }, 20_000);

      it('kills a run past 1,000 host calls', async () => {
        expect(
          await run(
            job(`for (let i = 0; i < 1100; i++) await host.collections.read('c', String(i));`),
          ),
        ).toMatch(/more than 1000 host calls/);
      }, 30_000);
    });

    describe('each ceiling ends the run', () => {
      it('heap past memoryMb', async () => {
        expect(await run(job(`const a = []; for (;;) a.push(new Array(1e4).fill(1));`))).toMatch(
          /killed|exited|memory/,
        );
      }, 30_000);

      it('ArrayBuffers past memoryMb, which the heap limit does not count', async () => {
        expect(
          await run(
            job(
              `const a = []; for (let i = 0; i < 64; i++) a.push(new Uint8Array(32 << 20).fill(1));`,
            ),
          ),
          // On the runner nothing but its RSS watchdog can see the process.
        ).toMatch(t === 'runner' ? /exceeded the memory limit of 64 MB/ : /memory|SIGKILL/);
      }, 30_000);

      it('the wall clock, also for a loop that never yields', async () => {
        const t = performance.now();
        expect(await run(job(`for (;;) {}`), { timeoutSeconds: 2 })).toMatch(/timeout of 2s/);
        expect(performance.now() - t).toBeLessThan(6000);
      }, 20_000);

      it("a file's bytes cross the channel apart from its 16 MiB of stdout (ADR 0031)", async () => {
        let got = -1;
        const out = await run(
          job(`
            const f = await host.files.put('a.pdf', new Uint8Array(20 << 20).fill(7));
            const back = await host.files.get(f.id);
            if (back.bytes.length !== 20 << 20 || back.bytes[12345] !== 7) throw new Error('lost the bytes');
          `),
          {
            memoryMb: 512,
            timeoutSeconds: 30,
            call: async (n, a) => {
              if (n !== 'files.put')
                return { id: 'f1', bytes: Buffer.alloc(20 << 20, 7).toString('base64') };
              got = Buffer.from(a[1] as string, 'base64').length;
              return { id: 'f1' };
            },
          },
        );
        expect(out).toBe('ok');
        expect(got).toBe(20 << 20);
      }, 60_000);

      it('a line past 48 MiB, and payloads past their own ceiling', async () => {
        expect(
          await run(
            job(
              `for (let i = 0; i < 50; i++) await Deno.stdout.write(new Uint8Array(1 << 20).fill(97));`,
            ),
            { timeoutSeconds: 30 },
          ),
        ).toMatch(/a line of more than 50331648 bytes/);
        const saved = RUNNER_LIMITS.payloadBytes;
        RUNNER_LIMITS.payloadBytes = 1 << 20;
        try {
          expect(
            await run(
              job(
                `for (let i = 0; i < 4; i++) await host.files.put('a.txt', new Uint8Array(300 << 10));`,
              ),
            ),
          ).toMatch(/more than 1048576 bytes of file and stream payload/);
        } finally {
          RUNNER_LIMITS.payloadBytes = saved;
        }
      }, 60_000);

      it('unload', async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        expect(await run(job(`await new Promise(() => {});`), { signal: ac.signal })).toMatch(
          /unloaded/,
        );
      }, 20_000);
    });
  });
}

describe('payload bytes (ADR 0031)', () => {
  it('are canonical base64 or refused, never decoded into other bytes', () => {
    expect([...fromBase64Strict('aGk=', 'x')]).toEqual([104, 105]);
    for (const bad of ['a@b=', 'aGk', 'aG k=', 'aGk=aGk=']) {
      expect(() => fromBase64Strict(bad, 'files.put: bytes')).toThrow(/must be base64/);
    }
  });
});

describe('the process itself', () => {
  it('a child whose stdin closes exits', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const child = spawn({
      cmd: [deno, 'run', '--no-prompt', `data:text/javascript;base64,${b64(RUNNER_BOOTSTRAP)}`],
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { DENO_DIR: join(sockDir, 'none') },
    });
    const code = b64('export default { j: () => new Promise(() => {}) };');
    child.stdin.write(`${JSON.stringify({ job: 'j', input: {}, timezone: 'UTC', code })}\n`);
    child.stdin.end();
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
    expect(exited).toBe(true);
  }, 20_000);
});

describe('the runner side', () => {
  it('reads the job header, and nothing else', () => {
    expect(parseJobHeader('JOB 128 60')).toEqual({ memoryMb: 128, timeoutSeconds: 60 });
    for (const bad of [
      'JOB 0 60',
      'JOB 128',
      'JOB -1 60',
      'JOB 12345 60',
      'EDGE 128 60',
      'JOB 1 1 ',
    ])
      expect(parseJobHeader(bad)).toBeNull();
  });

  it('spawns Deno through the wrap with no address-space limit and RLIMIT_CPU at twice the timeout', async () => {
    wrapped.length = 0;
    transport = 'runner';
    expect(await run(job(''), { timeoutSeconds: 7 })).toBe('ok');
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.addressSpace).toBe(false);
    expect(wrapped[0]!.argv.join(' ')).toContain('ulimit -t 14');
    expect(wrapped[0]!.argv.join(' ')).not.toContain('ulimit -v');
  }, 20_000);

  it('a spawn that throws ends the run at once, saying why, and gives the uid back', async () => {
    transport = 'runner';
    wrapThrows = true;
    released = 0;
    const t0 = performance.now();
    try {
      expect(await run(job(''), { timeoutSeconds: 30 })).toMatch(
        /the runner could not start the job: setpriv: not found/,
      );
    } finally {
      wrapThrows = false;
    }
    expect(performance.now() - t0).toBeLessThan(5000);
    // The wrap threw before handing out a uid; one that runs gives it back on exit.
    expect(await run(job(''))).toBe('ok');
    // The uid comes back when the process exits, after the run has answered.
    for (let i = 0; i < 100 && released < 1; i++) await Bun.sleep(20);
    expect(released).toBe(1);
  }, 20_000);

  it('asks the runner without waiting for one that is down', async () => {
    process.env.ZVELTIO_EXT_TRANSPORT = 'runner';
    expect(await runnerAnswers('acme/jobs')).toBe(true);
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = join(sockDir, 'gone.sock');
    try {
      const t0 = performance.now();
      expect(await runnerAnswers('acme/jobs')).toBe(false);
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      process.env.ZVELTIO_EXT_RUNNER_SOCKET = sock;
    }
  });

  it('a job line forged by the child is a malformed message on the engine', async () => {
    transport = 'process';
    expect(
      await run(job(`await Deno.stdout.write(new TextEncoder().encode('{"runner":{}}\\n'));`)),
    ).toMatch(/malformed host call/);
  }, 20_000);
});

describe('the Deno binary', () => {
  it('is refused when it or a directory above it is writable by other users', () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-deno-perm-'));
    try {
      const bin = join(base, '.deno', '2.9.8', 'deno');
      mkdirSync(join(base, '.deno', '2.9.8'), { recursive: true, mode: 0o755 });
      writeFileSync(bin, 'x', { mode: 0o755 });
      chmodSync(base, 0o755);
      expect(othersWritable(bin)).toBeNull();
      // Group-writable is the engine's group, which no extension uid holds.
      chmodSync(join(base, '.deno'), 0o775);
      expect(othersWritable(bin)).toBeNull();
      for (const p of [bin, join(base, '.deno', '2.9.8'), join(base, '.deno'), base]) {
        chmodSync(p, 0o777);
        expect(othersWritable(bin)).toBe(p);
        chmodSync(p, 0o755);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('production', () => {
  it("never runs a job as the engine's child: on `process` it waits", () => {
    process.env.NODE_ENV = 'production';
    try {
      process.env.ZVELTIO_EXT_TRANSPORT = 'process';
      expect(() => jobPlacement()).toThrow(/only on the extension runner/);
      delete process.env.ZVELTIO_EXT_TRANSPORT;
      expect(jobPlacement()).toBe('runner');
    } finally {
      restore('NODE_ENV', saved.env);
    }
  });
});

describe('unzipSingle', () => {
  it('reads a one-entry deflated archive', () => {
    const body = new TextEncoder().encode('deno binary'.repeat(100));
    const data = deflateRawSync(body);
    const name = new TextEncoder().encode('deno');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true);
    cd.set(name, 46);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(16, local.length + data.length, true);
    const zip = new Uint8Array([...local, ...data, ...cd, ...eocd]);
    expect(new TextDecoder().decode(unzipSingle(zip))).toBe('deno binary'.repeat(100));
    expect(() => unzipSingle(new Uint8Array(40))).toThrow(/one-entry zip/);
  });
});

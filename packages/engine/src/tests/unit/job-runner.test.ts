/**
 * The Deno job runner (ADR 0022), against the real pinned Deno: what the child
 * is refused, how each ceiling ends a run, and that every call reaches the
 * engine only as a message `call` answers. Items 1 and 2 of the ADR's
 * "Verified in implementation" list.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'bun';
import { ensureDeno, unzipSingle } from '../../lib/extensions/deno.js';
import { RUNNER_BOOTSTRAP, runInDeno, type HostCall } from '../../lib/extensions/job-runner.js';
import { deflateRawSync } from 'node:zlib';

let deno = '';
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
    await runInDeno({
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
}, 120_000);

describe('a job in Deno reaches nothing but the engine', () => {
  const refused: [string, string, RegExp][] = [
    ['fetch to any host', `await fetch('https://example.com');`, /Requires net access/],
    [
      'a raw socket',
      `await Deno.connect({ hostname: '127.0.0.1', port: 5432 });`,
      /Requires net access/,
    ],
    ['the environment', `Deno.env.get('DATABASE_URL');`, /Requires env access/],
    [
      'a read outside its copy of jobs.js',
      `await Deno.readTextFile('/etc/passwd');`,
      /Requires read access/,
    ],
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
      await run(job(`for (let i = 0; i < 1100; i++) await host.collections.read('c', String(i));`)),
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
        job(`const a = []; for (let i = 0; i < 64; i++) a.push(new Uint8Array(32 << 20).fill(1));`),
      ),
    ).toMatch(/memory|SIGKILL/);
  }, 30_000);

  it('the wall clock, also for a loop that never yields', async () => {
    const t = performance.now();
    expect(await run(job(`for (;;) {}`), { timeoutSeconds: 2 })).toMatch(/timeout of 2s/);
    expect(performance.now() - t).toBeLessThan(6000);
  }, 20_000);

  it('unload', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await run(job(`await new Promise(() => {});`), { signal: ac.signal })).toMatch(
      /unloaded/,
    );
  }, 20_000);

  it('a child whose stdin closes exits', async () => {
    const dir = (await import('node:fs')).mkdtempSync('/tmp/zv-runner-test-');
    await Bun.write(`${dir}/boot.js`, RUNNER_BOOTSTRAP);
    await Bun.write(`${dir}/jobs.js`, 'export default { j: () => new Promise(() => {}) };');
    const child = spawn({
      cmd: [
        deno,
        'run',
        '--no-prompt',
        `--allow-read=${dir}/jobs.js`,
        `${dir}/boot.js`,
        `${dir}/jobs.js`,
      ],
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
      env: {},
    });
    child.stdin.write(`${JSON.stringify({ job: 'j', input: {}, timezone: 'UTC' })}\n`);
    child.stdin.end();
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
    expect(exited).toBe(true);
  }, 20_000);
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

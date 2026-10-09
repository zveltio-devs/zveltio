/**
 * RFC extension-runner step 5: with ZVELTIO_EDGE_TRANSPORT=runner an edge
 * invocation crosses the runner's socket instead of being the engine's child.
 * The runner here is `routeConnection` on a socket in this process — the same
 * code `zveltio ext-runner` serves with, minus the uid it would run under
 * (ext-runner-compose.sh / ext-runner-systemd.sh prove that part). What these
 * assert is the contract callers rely on: the same RunResult as a local spawn,
 * the wall-clock kill reaching the process, and an extension's frames still
 * passing through the router untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  __bootstrapPathForTests,
  drainRunnerPool,
  edgeTransport,
  exchangeWithRunner,
  parseEdgeHeader,
  runEdgeFunctionInSubprocess,
  serveEdgeConnection,
} from '../../lib/edge-functions/subprocess-runner.js';
import {
  EDGE_RUNNER_INSTANCE,
  forgetEdgeRunner,
  routeConnection,
  runnerSetupFiles,
} from '../../lib/ext-runner.js';

const REQ: EdgeRequest = {
  method: 'POST',
  headers: {},
  query: { a: '1' },
  body: { x: 1 },
  path: '/',
};
const dir = mkdtempSync(join(tmpdir(), 'zv-edge-runner-test-'));
const sock = join(dir, 'runner.sock');
let server: Server;
const saved = {
  transport: process.env.ZVELTIO_EDGE_TRANSPORT,
  socket: process.env.ZVELTIO_EXT_RUNNER_SOCKET,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Run once locally and once over the runner, same code. */
async function both(code: string, env: Record<string, string> = {}, timeoutMs = 5000) {
  delete process.env.ZVELTIO_EDGE_TRANSPORT;
  const local = await runEdgeFunctionInSubprocess(code, REQ, env, timeoutMs);
  process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
  const runner = await runEdgeFunctionInSubprocess(code, REQ, env, timeoutMs);
  return { local, runner };
}

const strip = ({ duration_ms: _d, ...rest }: { duration_ms: number }) => rest;

beforeAll(async () => {
  server = createServer((conn) =>
    routeConnection(conn, {
      // An extension's channel is piped to its program unchanged; `cat` echoes it.
      workerArgv: ['cat'],
      childEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      wrap: (argv) => ({ argv }),
      serveEdge: serveEdgeConnection,
    }),
  );
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  process.env.ZVELTIO_EXT_RUNNER_SOCKET = sock;
  forgetEdgeRunner();
});

afterAll(async () => {
  restore('ZVELTIO_EDGE_TRANSPORT', saved.transport);
  restore('ZVELTIO_EXT_RUNNER_SOCKET', saved.socket);
  forgetEdgeRunner();
  await drainRunnerPool();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('edge functions over the runner', () => {
  it('is selected by ZVELTIO_EDGE_TRANSPORT=runner only', () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    expect(edgeTransport()).toBe('runner');
    // Not ZVELTIO_EXT_TRANSPORT: setup writes that on every bare-metal install.
    process.env.ZVELTIO_EDGE_TRANSPORT = 'worker';
    expect(edgeTransport()).toBe('process');
  });

  it('answers what a local spawn answers: response, env, request, logs', async () => {
    const { local, runner } = await both(
      `async function handler(request, env) {
        console.log('seen', request.query.a, env.K);
        return { status: 201, body: { x: request.body.x, k: env.K }, headers: { 'x-a': 'b' } };
      }`,
      { K: 'v' },
    );
    expect(runner.ok).toBe(true);
    expect(runner.response).toEqual({
      status: 201,
      body: { x: 1, k: 'v' },
      headers: { 'x-a': 'b' },
    });
    expect(strip(runner)).toEqual(strip(local));
  }, 20_000);

  it('keeps errors, stray stdout and the runtime stderr in the same shape', async () => {
    const thrown = await both(`async function handler() { throw new Error('boom'); }`);
    expect(thrown.runner).toMatchObject({ ok: false, error: 'boom' });
    expect(strip(thrown.runner)).toEqual(strip(thrown.local));

    const died = await both(`async function handler() {
      Promise.reject(new Error('unhandled-in-child'));
      await new Promise((r) => setTimeout(r, 50));
      return 1;
    }`);
    expect(died.runner.ok).toBe(false);
    expect(
      died.runner.logs.some((l) => l.startsWith('[stderr]') && l.includes('unhandled-in-child')),
    ).toBe(true);
    expect(died.runner.error).toBe(died.local.error!);
  }, 30_000);

  it('enforces the in-sandbox timeout the same way', async () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    const res = await runEdgeFunctionInSubprocess(
      'async function handler() { await new Promise(() => {}); }',
      REQ,
      {},
      300,
    );
    expect(res).toMatchObject({ ok: false, error: 'Execution timed out after 300ms' });
  }, 15_000);

  it('kills a runaway when the engine gives up, and leaves no process behind', async () => {
    await drainRunnerPool();
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    const res = await runEdgeFunctionInSubprocess(
      'async function handler() { for (;;) {} }',
      REQ,
      {},
      200,
    );
    expect(res).toMatchObject({ ok: false, error: 'Killed after the wall-clock timeout' });
    await Bun.sleep(300);
    const alive = readdirSync('/proc')
      .filter((p) => /^\d+$/.test(p))
      .filter((p) => {
        try {
          return readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(__bootstrapPathForTests);
        } catch {
          return false;
        }
      });
    expect(alive).toEqual([]);
  }, 15_000);

  it('reports a runner that is not there, and tries to start it again next time', async () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'runner';
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = join(dir, 'missing.sock');
    forgetEdgeRunner();
    const res = await runEdgeFunctionInSubprocess(
      'async function handler() { return 1; }',
      REQ,
      {},
      1000,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('missing.sock');
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = sock;
    const again = await runEdgeFunctionInSubprocess(
      'async function handler() { return 2; }',
      REQ,
      {},
      1000,
    );
    expect(again).toMatchObject({ ok: true, response: { body: 2 } });
  }, 15_000);
});

describe('the runner router', () => {
  it("pipes an extension's frames to its program unchanged", async () => {
    const frame = Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const c = connect(sock, () => c.write(frame));
      c.on('data', (d: Buffer) => {
        resolve(d);
        c.destroy();
      });
      c.on('error', reject);
    });
    expect(echoed.equals(frame)).toBe(true);
  });

  it('closes an edge connection whose header it cannot read, running nothing', async () => {
    const out = await exchangeWithRunner(sock, 'EDGE lots 1\n{}\n', 5000);
    expect(out.error).toContain('without a result');
  });

  it('reads only the header it defines', () => {
    expect(parseEdgeHeader('EDGE 1024 10')).toEqual({ memoryMb: 1024, cpuS: 10 });
    for (const bad of [
      'EDGE 1024',
      'EDGE -1 10',
      'EDGE 1 2 3',
      'edge 1 2',
      `EDGE 1 ${'9'.repeat(8)}`,
    ]) {
      expect(parseEdgeHeader(bad)).toBeNull();
    }
  });

  it('setup gives the edge instance room for concurrent invocations', () => {
    const files = runnerSetupFiles({ engineUser: 'zveltio', engineUid: 999, dir: '/opt/zveltio' });
    const dropIn =
      files[`/etc/systemd/system/zveltio-ext-runner@${EDGE_RUNNER_INSTANCE}.service.d/edge.conf`];
    expect(dropIn).toContain('TasksMax=512');
  });
});

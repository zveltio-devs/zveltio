// The same extension over both transports gives the same answers (RFC
// extension-runner, step 2).
//
// `ZVELTIO_EXT_TRANSPORT=process` runs the runtime as a child process speaking
// length-prefixed JSON frames on stdin/stdout instead of an in-thread worker
// speaking `postMessage`. Everything the protocol carries is exercised once per
// transport — init and the route table, a route with query, headers and a
// body, a `db:query`, a service the extension registers and calls, a large
// body, a log line, and an error — and the two transcripts must be identical.
// The last case is what only the process can show: the runner does not share
// the engine's process.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);

const entry = (name: string) => `
export default {
  name: '${name}',
  async register(app, ctx) {
    app.post('/echo/:id', async (c) => {
      const body = await c.req.json();
      console.log('echo', c.req.param('id'));
      return c.json(
        { id: c.req.param('id'), q: c.req.query('q'), h: c.req.header('x-probe'), body },
        201,
        { 'x-ext': 'yes' },
      );
    });
    app.get('/sql', async (c) => c.json(await ctx.db.query('SELECT 1 + 1 AS two')));
    ctx.services.register('${name}.double', (n) => n * 2);
    app.get('/svc', async (c) => c.json({ out: await ctx.services.get('${name}.double')(21) }));
    app.get('/big', (c) => c.text('z'.repeat(3 * 1024 * 1024)));
    app.get('/boom', () => { throw new Error('boom'); });
    app.get('/env', (c) => c.json(Object.keys(Bun.env)));
    // The worker's \`process\` is a shim: ask the kernel (Linux, as CI).
    app.get('/pid', async (c) =>
      c.json({ pid: Number((await Bun.file('/proc/self/stat').text()).split(' ')[0]) }),
    );
  },
};
`;

async function transcript(app: Hono, name: string) {
  const echo = await app.request(`/ext/${name}/echo/7?q=hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-probe': 'p' },
    body: JSON.stringify({ a: [1, 'ü', null] }),
  });
  const big = await app.request(`/ext/${name}/big`);
  const boom = await app.request(`/ext/${name}/boom`);
  return {
    echo: { status: echo.status, ext: echo.headers.get('x-ext'), body: await echo.json() },
    sql: await (await app.request(`/ext/${name}/sql`)).json(),
    svc: await (await app.request(`/ext/${name}/svc`)).json(),
    big: { status: big.status, length: (await big.text()).length },
    boom: boom.status,
  };
}

d('worker transport contract: thread and process answer alike', () => {
  let db: Database;
  let base = '';
  const results: Record<string, unknown> = {};
  const pids: Record<string, number> = {};
  const envs: Record<string, string[]> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-transport-'));
    for (const transport of ['worker', 'process'] as const) {
      const name = `wkrtp${transport[0]}${SFX}`;
      const dir = join(base, name);
      mkdirSync(join(dir, 'engine'), { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        }),
      );
      writeFileSync(join(dir, 'engine', 'index.js'), entry(name));

      process.env.ZVELTIO_EXT_TRANSPORT = transport;
      _resetWorkerHostForTests();
      const app = new Hono();
      getWorkerHost(app);
      const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
      await extensionLoader.loadExtension(name, app, ctx, base);
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
      try {
        results[transport] = await transcript(app, name);
        envs[transport] = (await (await app.request(`/ext/${name}/env`)).json()) as string[];
        pids[transport] = (
          (await (await app.request(`/ext/${name}/pid`)).json()) as {
            pid: number;
          }
        ).pid;
      } finally {
        await getWorkerHost(app).stopAll();
        await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
      }
    }
  }, 60_000);

  afterAll(() => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('the worker transcript is what the extension answers (the setup is real)', () => {
    expect(results.worker).toEqual({
      echo: {
        status: 201,
        ext: 'yes',
        body: { id: '7', q: 'hello', h: 'p', body: { a: [1, 'ü', null] } },
      },
      sql: [{ two: 2 }],
      svc: { out: 42 },
      big: { status: 200, length: 3 * 1024 * 1024 },
      boom: 500,
    });
  });

  it('the process transcript is identical', () => {
    expect(results.process).toEqual(results.worker);
  });

  it("neither sees the engine's environment", () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
    for (const keys of [envs.worker, envs.process]) {
      expect(keys).toContain('NODE_ENV');
      expect(keys).not.toContain('DATABASE_URL');
      expect(keys).not.toContain('BETTER_AUTH_SECRET');
      expect(keys).not.toContain('FIELD_ENCRYPTION_KEY');
    }
  });

  it('the thread shares the engine process; the runner does not', () => {
    expect(pids.worker).toBe(process.pid);
    expect(pids.process).not.toBe(process.pid);
  });
});

// The frame transport carries the whole protocol (RFC extension-runner, steps 2
// and 9).
//
// `ZVELTIO_EXT_TRANSPORT=process` runs the runtime as a child process speaking
// length-prefixed JSON frames on stdin/stdout — the frames the runner pipes
// unchanged, so the runner carries the same. Everything the protocol carries is
// exercised — init and the route table, a route with query, headers and a body,
// a `db:query`, a service the extension registers and calls, a large body, a log
// line, and an error — and the transcript must be what the extension answers.
// The extension runs in a process of its own, without the engine's environment.
// (Step 2 compared this transcript with the in-thread worker's; step 9 removed
// the thread.)
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

d('worker transport contract: the process transport carries the protocol', () => {
  let db: Database;
  let base = '';
  const results: Record<string, unknown> = {};
  const pids: Record<string, number> = {};
  const envs: Record<string, string[]> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-transport-'));
    for (const transport of ['process'] as const) {
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

  it('the transcript is what the extension answers', () => {
    expect(results.process).toEqual({
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

  it("it does not see the engine's environment", () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(envs.process).toContain('NODE_ENV');
    expect(envs.process).not.toContain('DATABASE_URL');
    expect(envs.process).not.toContain('BETTER_AUTH_SECRET');
    expect(envs.process).not.toContain('FIELD_ENCRYPTION_KEY');
  });

  it("it runs outside the engine's process", () => {
    expect(pids.process).toBeGreaterThan(0);
    expect(pids.process).not.toBe(process.pid);
  });
});

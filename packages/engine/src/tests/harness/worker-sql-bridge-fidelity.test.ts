// The worker SQL bridge answers as the inline driver does (RFC extension-runner,
// step 6). Each case was measured broken out of process in the experiment
// (docs/engine/rfc-extension-runner-experiment.md): JS arrays reached Postgres
// unconverted, the SQLSTATE was dropped (a unique violation the extension maps
// to 400 became a 500), UPDATE/DELETE without RETURNING reported no affected
// rows, an Error logged by the extension reached the engine log as `{}`, and
// boot spawned every worker twice (once into the throwaway app, once more on
// the real one). Driven through the real loader, over both transports.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const TRANSPORTS = ['worker', 'process'] as const;
const extName = (t: string) => `wkrsql${t[0]}${SFX}`;
const table = (t: string) => `zv_${extName(t)}_items`;

/** The body as JSON, or as text when a failure answered plain text. */
async function body(r: Response): Promise<unknown> {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const entry = (name: string, t: string) => `
const BOOT = crypto.randomUUID();
export default {
  name: '${name}',
  async register(app, ctx) {
    app.get('/boot', (c) => c.text(BOOT));
    app.post('/arr', async (c) => {
      try {
        const ins = await ctx.db.query(
          'INSERT INTO ${t} (tag, tags) VALUES ($1, $2) RETURNING tags', 'a', ['x', 'y"z', null]);
        const any = await ctx.db.query(
          'SELECT count(*)::int AS n FROM ${t} WHERE tag = ANY($1)', ['a', 'nope']);
        return c.json({ tags: ins[0].tags, n: any[0].n });
      } catch (e) { return c.json({ error: e.message }, 500); }
    });
    app.post('/dup', async (c) => {
      try {
        await ctx.db.query("INSERT INTO ${t} (tag) VALUES ('dup')");
        await ctx.db.query("INSERT INTO ${t} (tag) VALUES ('dup')");
        return c.json({}, 201);
      } catch (e) {
        // What finance/invoicing does inline to answer "already exists".
        const state = e.errno ?? e.code;
        return c.json({ errno: e.errno ?? null }, state === '23505' ? 400 : 500);
      }
    });
    app.post('/count', async (c) => {
      await ctx.db.query("INSERT INTO ${t} (tag) VALUES ('c')");
      const u = await ctx.db.query("UPDATE ${t} SET note = 'n' WHERE tag = $1", 'c');
      const d = await ctx.db.query('DELETE FROM ${t} WHERE tag = $1', 'c');
      return c.json({ updated: u.count, deleted: d.count });
    });
    app.get('/log', (c) => {
      console.error(Object.assign(new Error('kaput'), { code: 'E_KAPUT' }));
      return c.text('ok');
    });
  },
};
`;

d('worker SQL bridge answers as the inline driver does', () => {
  let db: Database;
  let base = '';
  const out: Record<string, Record<string, unknown>> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const savedCtx = extensionLoader.ctx;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'wkr-sql-'));
    for (const transport of TRANSPORTS) {
      const name = extName(transport);
      const dir = join(base, name);
      mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        }),
      );
      writeFileSync(join(dir, 'engine', 'index.js'), entry(name, table(transport)));
      writeFileSync(
        join(dir, 'engine', 'migrations', '001_items.sql'),
        `CREATE TABLE IF NOT EXISTS ${table(transport)} ` +
          '(id serial PRIMARY KEY, tag text UNIQUE, note text, tags text[]);\n' +
          `-- DOWN\nDROP TABLE IF EXISTS ${table(transport)};\n`,
      );

      process.env.ZVELTIO_EXT_TRANSPORT = transport;
      _resetWorkerHostForTests();
      // Boot as index.ts does it: load into a throwaway app, then re-register on
      // the app that serves.
      const tempApp = new Hono();
      const app = new Hono();
      getWorkerHost(tempApp);
      const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
      // `loadAll` sets it at boot; `reRegisterExtension` does nothing without it.
      extensionLoader.ctx = ctx;
      await extensionLoader.loadExtension(name, tempApp, ctx, base);
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
      const errors = spyOn(console, 'error');
      try {
        const bootBefore = await (await tempApp.request(`/ext/${name}/boot`)).text();
        await extensionLoader.reRegisterExtension(name, app);
        const boot = await app.request(`/ext/${name}/boot`);
        const arr = await app.request(`/ext/${name}/arr`, { method: 'POST' });
        const dup = await app.request(`/ext/${name}/dup`, { method: 'POST' });
        const count = await app.request(`/ext/${name}/count`, { method: 'POST' });
        await app.request(`/ext/${name}/log`);
        out[transport] = {
          sameWorker: boot.status === 200 && (await boot.text()) === bootBefore,
          arr: { status: arr.status, body: await body(arr) },
          dup: { status: dup.status, body: await body(dup) },
          count: await body(count),
          log: errors.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('kaput')) ?? '',
        };
      } finally {
        errors.mockRestore();
        await getWorkerHost(app).stopAll();
        await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
      }
    }
  }, 90_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    extensionLoader.ctx = savedCtx;
    _resetWorkerHostForTests();
    for (const t of TRANSPORTS) {
      await sql`DROP TABLE IF EXISTS ${sql.table(table(t))}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${extName(t)}:%`}`.execute(db);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const t of TRANSPORTS) {
    describe(t, () => {
      it('boot spawns the worker once: re-registering on the serving app keeps it', () => {
        expect(out[t]?.sameWorker).toBe(true);
      });

      it('encodes array parameters as the inline driver does', () => {
        expect(out[t]?.arr).toEqual({ status: 200, body: { tags: ['x', 'y"z', null], n: 1 } });
      });

      it('keeps the SQLSTATE, so a unique violation maps to 400', () => {
        expect(out[t]?.dup).toEqual({ status: 400, body: { errno: '23505' } });
      });

      it('reports the rows an UPDATE and a DELETE without RETURNING touched', () => {
        expect(out[t]?.count).toEqual({ updated: 1, deleted: 1 });
      });

      it('logs an Error with its message, code and stack, not as {}', () => {
        const line = out[t]?.log as string;
        expect(line).toContain('kaput');
        expect(line).toContain('E_KAPUT');
        expect(line).toMatch(/\n\s+at /);
      });
    });
  }
});

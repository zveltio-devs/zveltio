/**
 * A worker-isolated extension reaches its own tables through the SQL bridge.
 *
 * The bridge runs every worker query as `zveltio_worker`, which held grants on
 * collections only (migration 001, `applyTenantRLS`). The tables a worker
 * extension's own migrations create — `zv_<ext>_*` and `zvd_*`, both admitted by
 * the analyzer — were never granted, so every such query answered `permission
 * denied`; and the boot reconcile revokes every non-collection `zvd_*` table.
 *
 * Driven end to end: the real loader runs the extension's migration, spawns the
 * runtime as a process, mounts its proxy routes; the route's `ctx.db.query` crosses
 * the IPC bridge to `runRawWithParams` and `SET LOCAL ROLE` to the extension's
 * own role under `zveltio_worker`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { extensionDbRoleNames, revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { reconcileTenantRLS } from '../../lib/tenancy/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const EXT = 'wkrown';
const OWN = 'zv_wkrown_items';
// The first-party convention: an extension table named `zvd_*`, not a collection.
const OWN_ZVD = 'zvd_wkrown_logs';

const ENTRY = `
export default {
  name: '${EXT}',
  async register(app, ctx) {
    app.post('/items', async (c) => {
      try {
        const rows = await ctx.db.query("INSERT INTO ${OWN} (note) VALUES ($1) RETURNING note", 'hi');
        return c.json({ ok: true, rows });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
    app.get('/items', async (c) => {
      try {
        return c.json({ ok: true, rows: await ctx.db.query('SELECT note FROM ${OWN} ORDER BY id') });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
    app.post('/logs', async (c) => {
      try {
        await ctx.db.query("INSERT INTO ${OWN_ZVD} (line) VALUES ('x')");
        return c.json({ ok: true, rows: await ctx.db.query('SELECT count(*)::int AS n FROM ${OWN_ZVD}') });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
    app.get('/whoami', async (c) => c.json(await ctx.db.query('SELECT current_user::text AS r')));
    app.get('/sneak', async (c) => {
      try {
        return c.json({ ok: true, rows: await ctx.db.query('SELECT count(*) FROM zvd_permissions') });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
  },
};
`;

d('a worker extension reaches its own tables through the bridge', () => {
  let db: Database;
  let base: string;
  const app = new Hono();

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'wkr-own-'));
    const dir = join(base, EXT);
    mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: EXT,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), ENTRY);
    writeFileSync(
      join(dir, 'engine', 'migrations', '001_items.sql'),
      `CREATE TABLE IF NOT EXISTS ${OWN} (id serial PRIMARY KEY, note text);\n` +
        `CREATE TABLE IF NOT EXISTS ${OWN_ZVD} (id bigserial PRIMARY KEY, line text);\n` +
        `-- DOWN\nDROP TABLE IF EXISTS ${OWN};\nDROP TABLE IF EXISTS ${OWN_ZVD};\n`,
    );
    _resetWorkerHostForTests();
    getWorkerHost(app);
    // ctx is what the boot path hands the loader; only db + fieldTypeRegistry are read here.
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    await extensionLoader.loadExtension(EXT, app, ctx, base);
    expect(extensionLoader.getLastLoadError(EXT)).toBeUndefined();
  }, 60_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    await sql`DROP TABLE IF EXISTS ${sql.table(OWN)}`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.table(OWN_ZVD)}`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
    await revokeExtensionDbRoles(db, EXT, true);
    rmSync(base, { recursive: true, force: true });
  });

  it('writes and reads its own migration table', async () => {
    const w = await app.request(`/ext/${EXT}/items`, { method: 'POST' });
    expect(await w.json()).toEqual({ ok: true, rows: [{ note: 'hi' }] });
    const r = await app.request(`/ext/${EXT}/items`);
    expect(await r.json()).toEqual({ ok: true, rows: [{ note: 'hi' }] });
  }, 30_000);

  it('keeps its zvd_* table across the boot reconcile, which revokes non-collections', async () => {
    await reconcileTenantRLS(db);
    const r = await app.request(`/ext/${EXT}/logs`, { method: 'POST' });
    expect(await r.json()).toEqual({ ok: true, rows: [{ n: 1 }] });
  }, 60_000);

  it('runs bridge queries as its own role, which holds its relations and no engine table', async () => {
    const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!
      .d;
    const role = extensionDbRoleNames(dbName, EXT).worker;
    const who = await app.request(`/ext/${EXT}/whoami`);
    expect(await who.json()).toEqual([{ r: role }]);
    const r = await sql<{ t: string; own: boolean; shared: boolean }>`
      SELECT t, has_table_privilege(${role}, t, 'INSERT') AS own,
             has_table_privilege('zveltio_worker', t, 'INSERT') AS shared
        FROM unnest(${[OWN, OWN_ZVD, 'zv_api_keys', 'zvd_permissions', 'zv_tenants']}::text[]) t
    `.execute(db);
    // The shared role keeps collections only, so no other worker extension reaches these.
    expect(Object.fromEntries(r.rows.map((x) => [x.t, [x.own, x.shared]]))).toEqual({
      [OWN]: [true, false],
      [OWN_ZVD]: [true, false],
      zv_api_keys: [false, false],
      zvd_permissions: [false, false],
      zv_tenants: [false, false],
    });
  }, 30_000);

  it('still cannot reach the engine metadata the analyzer refuses', async () => {
    const r = await app.request(`/ext/${EXT}/sneak`);
    const body = (await r.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/zvd_permissions/);
  }, 30_000);
});

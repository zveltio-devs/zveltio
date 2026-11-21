/**
 * ADR 0056 amendment 2026-11-21: level 2 (registry-signed community, on the
 * runner) is held to the declared model, as level 3 is. The refusals fired only
 * for an operator key, so a registry-signed worker extension still registered
 * routes from `register()`, queried over the SQL bridge (`ctx.db`), called and
 * registered services, used `ctx.events`, and shipped `engine/migrations/*.sql`
 * run as the engine.
 *
 * Signed as the registry signs (the archive and its signature kept with the
 * files, `.zveltio-registry/`), loaded through the engine's own loader.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  exportTrustedKeyEntry,
  generateKeypair,
  signBundle,
  type ZveltioKeypair,
} from '@zveltio/sdk/publish';
import type { Database } from '../../db/index.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { REGISTRY_SIGNED_DIR } from '../../lib/security/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const names: string[] = [];

d('a registry-signed worker extension is declared model only (level 2)', () => {
  let db: Database;
  let base = '';
  let kp: ZveltioKeypair;
  const app = new Hono();
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
    registry: process.env.REGISTRY_PUBLIC_KEYS_JSON,
  };

  /** A bundled worker extension, kept with the archive and signature the registry made of it. */
  async function write(
    name: string,
    bundle: { before?: string; register?: string } = {},
    migration?: string,
  ): Promise<void> {
    names.push(name);
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
    writeFileSync(
      join(dir, 'engine', 'index.js'),
      (bundle.before ?? '') +
        `export default { name: '${name}', ${bundle.register ?? `async register() { console.warn('hello from ${name}'); }`} };\n`,
    );
    if (migration !== undefined) {
      mkdirSync(join(dir, 'engine', 'migrations'));
      writeFileSync(join(dir, 'engine', 'migrations', '001_x.sql'), migration);
    }
    const tgz = join(base, `${name.replaceAll('/', '_')}.tar.gz`);
    expect(await Bun.spawn(['tar', '-czf', tgz, '-C', dir, '.']).exited).toBe(0);
    const archive = new Uint8Array(readFileSync(tgz));
    mkdirSync(join(dir, REGISTRY_SIGNED_DIR));
    writeFileSync(join(dir, REGISTRY_SIGNED_DIR, 'archive'), archive);
    writeFileSync(
      join(dir, REGISTRY_SIGNED_DIR, 'archive.sig'),
      JSON.stringify(await signBundle(archive, kp)),
    );
  }
  const ctx = () => extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
  async function load(name: string): Promise<string | undefined> {
    await markInstalled(db, name);
    await extensionLoader.loadExtension(name, app, ctx(), base);
    return extensionLoader.getLastLoadError(name);
  }
  const running = (name: string) => getWorkerHost(app).isRunning(name);

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'reg-signed-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    kp = await generateKeypair(`registry-${STAMP}`);
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
    ]);
    // A signed extension is held to its level whatever the test override says.
    _setInlineForTests(false);
    _resetWorkerHostForTests();
    getWorkerHost(app);
  });

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const name of names) {
      await extensionLoader.unload(name).catch(() => {});
      await forgetInstalled(db, name);
    }
    for (const [k, v] of Object.entries({
      ZVELTIO_EXT_TRANSPORT: saved.transport,
      REGISTRY_PUBLIC_KEYS_JSON: saved.registry,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('loads one that declares only, on the runner, its log naming the registry key', async () => {
    const name = `l2${STAMP}/ok`;
    await write(name);
    const warn = spyOn(console, 'warn');
    try {
      expect(await load(name)).toBeUndefined();
      expect(running(name)).toBe(true);
      const said = () => warn.mock.calls.some((c) => /hello from/.test(String(c[0])));
      for (let i = 0; i < 40 && !said(); i++) await Bun.sleep(50);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
        `[ext:${name} key=${kp.keyId}] hello from ${name}`,
      );
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('fails the load of a register() that uses its app or its ctx', async () => {
    for (const [what, register] of [
      ['app', `async register(app) { app.get('/x', (c) => c.text('x')); }`],
      ['ctx', `async register(_app, ctx) { await ctx.db.query('select 1 as n'); }`],
    ] as const) {
      const name = `l2${STAMP}/reg-${what}`;
      await write(name, { register });
      expect(await load(name)).toMatch(
        new RegExp(`register\\(\\) used ${what}\\.\\w+: .*declared model only`),
      );
      expect(running(name)).toBe(false);
      expect((await app.request(`/ext/${name}/x`)).status).not.toBe(200);
    }
  }, 60_000);

  it('refuses on the host what register()’s ctx would send, even as a forged frame', async () => {
    const name = `l2${STAMP}/forged`;
    const before = `import { writeSync } from 'node:fs';
const frame = (m) => { const b = new TextEncoder().encode(JSON.stringify(m)); const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length); o.set(b, 4); return o; };
const parse = JSON.parse;
JSON.parse = (t, r) => { const v = parse(t, r); if (v && String(v.id).startsWith('forged-')) console.warn('forged ' + v.id + ' ' + v.type + ' ' + (v.error ?? JSON.stringify(v.rows ?? v.result ?? null))); return v; };
for (const m of [
  { type: 'db:query', id: 'forged-db', sql: 'select 42 as n', params: [] },
  { type: 'host:call', id: 'forged-host', op: 'emit', args: ['forged.event', {}] },
  { type: 'service:register', id: 'forged-reg', name: 'forged.svc' },
  { type: 'service:call', id: 'forged-call', name: 'forged.svc', args: [] },
]) writeSync(1, frame(m));
`;
    await write(name, { before, register: 'async register() {}' });
    const warn = spyOn(console, 'warn');
    try {
      expect(await load(name)).toBeUndefined();
      const replies = () =>
        warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('] forged '));
      for (let i = 0; i < 60 && replies().length < 4; i++) await Bun.sleep(50);
      for (const id of ['forged-db', 'forged-host', 'forged-reg', 'forged-call']) {
        expect(replies().find((l) => l.includes(` ${id} `))).toMatch(
          /:err .* is refused: .*level 2.*declared model only/,
        );
      }
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('refuses raw SQL migrations: it declares its collections', async () => {
    const name = `l2${STAMP}/migr`;
    const table = `zv_l2${STAMP}_t`;
    await write(name, {}, `CREATE TABLE ${table} (id int);\n`);
    expect(await load(name)).toMatch(/declared model only: declare its collections/);
    expect(running(name)).toBe(false);
    const made = await db
      .selectFrom('information_schema.tables' as never)
      .select('table_name' as never)
      .where('table_name' as never, '=', table as never)
      .execute();
    expect(made).toEqual([]);
  }, 60_000);
});

/**
 * POST /api/marketplace/<name>/update replaces an installed extension in place,
 * here and on every other replica, and never at the cost of the version running.
 *
 * Before it, the only way to a new version was uninstall + install: install
 * keeps whatever is on disk ("local files win"), and a replica receiving the
 * lifecycle announcement fetched a bundle only when its disk held none, so one
 * already running version N kept running N while the record said N+1.
 *
 * This process is replica A (the route) and, through the bus's dispatcher,
 * replica B (the announcement). The registry is faked over `fetch`, signing and
 * declaring the SHA-256 of a real archive, so every check the download makes is
 * the real one. Each "tampered" case proves the old version keeps running.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import {
  _resetCatalogCacheForTests,
  REGISTRY_URL,
} from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { clearRevocationCache } from '../../lib/extensions/revocations.js';
import { dispatchToWs, EXTENSION_LIFECYCLE_EVENT, engineEvents } from '../../lib/runtime/index.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// In the bundled catalog as first-party, so it may load inline.
const NAME = 'hello-ext';
const T1 = 'zv_hello_ext_update_one';
const T2 = 'zv_hello_ext_update_two';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');

d('updating an extension in place', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  let scratch = '';
  let archive: Uint8Array<ArrayBuffer>;
  let sha = '';
  let sigJson = '';
  /** A 1.1.0 that verifies but throws when it starts. */
  const broken = { archive: new Uint8Array(), sigJson: '', sha: '' };
  const realFetch = globalThis.fetch;
  const saved = {
    extDir: process.env.EXTENSIONS_DIR,
    keys: process.env.REGISTRY_PUBLIC_KEYS_JSON,
    devReload: process.env.ZVELTIO_EXTENSION_DEV_RELOAD,
    ctx: extensionLoader.ctx,
  };

  const tableExists = async (t: string) =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${t})::text AS t`.execute(db)).rows[0]?.t !=
    null;
  const godRow = async () =>
    (
      await sql<{ v: string | null; s: string | null }>`
        SELECT installed_version AS v, installed_sha256 AS s FROM zv_extension_registry
        WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0];
  const onDisk = () =>
    JSON.parse(readFileSync(join(base, NAME, 'manifest.json'), 'utf8')).version as string;
  const loadedVersion = () => extensionLoader.loaded.get(NAME)?.version;

  /** Version `version` of the extension in `dir`, declaring `tables`' migrations. */
  const writeVersion = async (dir: string, version: string, tables: string[], broken = false) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.version = version;
    rmSync(dir, { recursive: true, force: true });
    await Bun.write(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const files = tables.map((t, i) => `migrations/00${i + 1}_${t}.sql`);
    for (const [i, t] of tables.entries()) {
      await Bun.write(
        join(dir, 'engine', files[i] as string),
        `CREATE TABLE ${t} (id int);\n-- DOWN\nDROP TABLE IF EXISTS ${t};\n`,
      );
    }
    await Bun.write(
      join(dir, 'engine/index.js'),
      `import { join } from 'node:path';
       export default {
         name: ${JSON.stringify(NAME)},
         category: 'fixture',
         getMigrations: () => ${JSON.stringify(files)}.map((f) => join(import.meta.dir, f)),
         async register() { ${broken ? "throw new Error('1.1.0 cannot start');" : ''} },
       };`,
    );
  };

  /** The registry serves 1.1.0: catalog, the archive declaring `declared`, its signature. */
  const serveRegistry = (declared: string, bundle = { archive, sigJson }) => {
    _resetCatalogCacheForTests();
    clearRevocationCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(REGISTRY_URL)) return realFetch(input, init);
      if (url.endsWith('/api/extensions/list'))
        return Response.json({
          extensions: [{ name: NAME, version: '1.1.0', publisher_tier: 'first-party' }],
        });
      if (url.endsWith('/api/revocations')) return Response.json({ revocations: [] });
      if (url.endsWith('/download.sig')) return new Response(bundle.sigJson);
      if (url.endsWith('/download'))
        return new Response(bundle.archive, { headers: { 'X-Archive-Sha256': declared } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  };

  /**
   * 1.0.0 installed from the registry and running; the registry row says so. With
   * `record`, the row already names 1.1.0 and `pinned` as another replica's update left it.
   */
  const runningV1 = async (record?: { pinned: string }) => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    for (const t of [T1, T2]) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await writeVersion(join(base, NAME), '1.0.0', [T1]);
    await sql`INSERT INTO zv_extension_registry
                (name, display_name, is_installed, is_enabled, version, installed_version, installed_sha256)
              VALUES (${NAME}, ${NAME}, true, true, '1.0.0', '1.0.0', ${'11'.repeat(32)})`.execute(
      db,
    );
    await extensionLoader.loadDynamic(NAME, engine);
    expect(loadedVersion()).toBe('1.0.0');
    if (record) {
      await sql`UPDATE zv_extension_registry
                SET version = '1.1.0', installed_version = '1.1.0', installed_sha256 = ${record.pinned}
                WHERE name = ${NAME}`.execute(db);
    }
  };

  const update = () =>
    engine.request(`/api/marketplace/${NAME}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });
  const announce = () =>
    dispatchToWs({
      originId: 'replica-a',
      event: EXTENSION_LIFECYCLE_EVENT,
      collection: NAME,
      timestamp: new Date().toISOString(),
    });

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-update-'));
    scratch = mkdtempSync(join(tmpdir(), 'zv-update-src-'));
    process.env.EXTENSIONS_DIR = base;
    // The production import path: no dev-reload copy to hide Bun's cache.
    delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
    // The archive the registry serves: version 1.1.0, one migration more.
    await writeVersion(join(scratch, 'v2'), '1.1.0', [T1, T2]);
    const tgz = join(scratch, 'v2.tar.gz');
    expect(await Bun.spawn(['tar', '-czf', tgz, '-C', join(scratch, 'v2'), '.']).exited).toBe(0);
    archive = new Uint8Array(readFileSync(tgz));
    sha = createHash('sha256').update(archive).digest('hex');
    const kp = await generateKeypair('update-test');
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
    ]);
    sigJson = JSON.stringify(await signBundle(archive, kp));
    await writeVersion(join(scratch, 'v2-broken'), '1.1.0', [T1, T2], true);
    const btgz = join(scratch, 'v2-broken.tar.gz');
    expect(
      await Bun.spawn(['tar', '-czf', btgz, '-C', join(scratch, 'v2-broken'), '.']).exited,
    ).toBe(0);
    broken.archive = new Uint8Array(readFileSync(btgz));
    broken.sha = createHash('sha256').update(broken.archive).digest('hex');
    broken.sigJson = JSON.stringify(await signBundle(broken.archive, kp));
    extensionLoader.ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.setReloadCallback(async () => {});
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await extensionLoader.unload(NAME).catch(() => undefined);
    extensionLoader.ctx = saved.ctx;
    for (const [k, v] of [
      ['EXTENSIONS_DIR', saved.extDir],
      ['REGISTRY_PUBLIC_KEYS_JSON', saved.keys],
      ['ZVELTIO_EXTENSION_DEV_RELOAD', saved.devReload],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (db) {
      for (const t of [T1, T2]) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    _resetCatalogCacheForTests();
    clearRevocationCache();
    for (const dir of [base, scratch]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the route swaps 1.1.0 in, runs its migration, reloads it and records its digest', async () => {
    await runningV1();
    serveRegistry(sha);
    const res = await update();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: true, from: '1.0.0', version: '1.1.0' });
    expect(loadedVersion()).toBe('1.1.0');
    expect(onDisk()).toBe('1.1.0');
    expect(await tableExists(T2)).toBe(true);
    expect(await godRow()).toEqual({ v: '1.1.0', s: sha });
    expect(readdirSync(base).filter((e) => e.startsWith('.update-'))).toEqual([]);
    // Again: already there.
    expect(await (await update()).json()).toMatchObject({ updated: false, version: '1.1.0' });
  }, 60_000);

  it('a tampered bundle is refused and 1.0.0 keeps running', async () => {
    await runningV1();
    serveRegistry('0'.repeat(64));
    const res = await update();
    expect(res.status).toBe(422);
    // Problem details: the message rides in `detail`.
    expect(((await res.json()) as { detail: string }).detail).toContain('SHA-256 mismatch');
    expect(extensionLoader.isActive(NAME)).toBe(true);
    expect(loadedVersion()).toBe('1.0.0');
    expect(onDisk()).toBe('1.0.0');
    expect(await tableExists(T2)).toBe(false);
    expect((await godRow())?.v).toBe('1.0.0');
  }, 60_000);

  it('install refuses where update is meant, and changes nothing', async () => {
    await runningV1();
    serveRegistry(sha);
    const res = await engine.request(`/api/marketplace/${NAME}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });
    expect(res.status).toBe(409);
    expect(loadedVersion()).toBe('1.0.0');
    expect(onDisk()).toBe('1.0.0');
  }, 60_000);

  it('another replica still running 1.0.0 fetches the recorded 1.1.0 and reloads it', async () => {
    await runningV1({ pinned: sha });
    serveRegistry(sha);
    await announce();
    expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
    expect(loadedVersion()).toBe('1.1.0');
    expect(onDisk()).toBe('1.1.0');
  }, 60_000);

  it('another replica refuses bytes that miss the digest the update pinned: 1.0.0 keeps running', async () => {
    await runningV1({ pinned: 'ff'.repeat(32) });
    serveRegistry(sha);
    await announce();
    expect(extensionLoader.isActive(NAME)).toBe(true);
    expect(loadedVersion()).toBe('1.0.0');
    expect(onDisk()).toBe('1.0.0');
  }, 60_000);

  it('another replica where the new version fails to start puts 1.0.0 back and runs it', async () => {
    await runningV1({ pinned: broken.sha });
    serveRegistry(broken.sha, broken);
    await announce();
    expect(extensionLoader.isActive(NAME)).toBe(true);
    expect(loadedVersion()).toBe('1.0.0');
    expect(onDisk()).toBe('1.0.0');
    expect(readdirSync(base).filter((e) => e.startsWith('.update-'))).toEqual([]);
  }, 60_000);

  it('the route where the new version fails to start puts 1.0.0 back and runs it', async () => {
    await runningV1();
    serveRegistry(broken.sha, broken);
    const res = await update();
    expect(res.status).toBe(422);
    expect(loadedVersion()).toBe('1.0.0');
    expect(onDisk()).toBe('1.0.0');
    expect((await godRow())?.v).toBe('1.0.0');
  }, 60_000);
});

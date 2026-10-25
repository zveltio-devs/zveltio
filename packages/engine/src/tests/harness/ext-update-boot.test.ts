/**
 * What boot does with an update another replica, or a crash, left half done.
 *
 * 1. A crash during POST /api/marketplace/<name>/update leaves its staging
 *    directory (`.update-<name>.XXXXXX`, holding the old bundle as `.previous`
 *    once swapped). Boot settles it under the extension's lock: the old bundle
 *    comes back unless the directory holds the version on record.
 * 2. Two replicas booting onto one shared extensions directory that is behind
 *    the record (or empty) fetched the bundle both at once, unlocked, and swapped
 *    it over each other. Now one fetches under the extension's lock; the other
 *    waits, finds it done and fetches nothing. Each replica runs on a pool of two,
 *    the floor, so a lock holder that starved its own work would hang here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import type { Database } from '../../db/index.js';
import type { ExtensionCatalogEntry } from '../../lib/extensions/extension-catalog.js';
import {
  _resetCatalogCacheForTests,
  REGISTRY_URL,
  stageExtensionDir,
  sweepUpdateLeftovers,
} from '../../lib/extensions/extension-download.js';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { clearRevocationCache } from '../../lib/extensions/revocations.js';
import { _lockTailForTests, withExtensionLock } from '../../lib/extensions/extension-utils.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// In the bundled catalog as first-party, so the registry's tier is the bundled one.
const NAME = 'hello-ext';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const src = (p: string) => new URL(p, import.meta.url).pathname;

d('boot and a half-done extension update', () => {
  let db: Database;
  let base = '';
  let scratch = '';

  const version = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version as string;
  const leftovers = () => readdirSync(base).filter((e) => e.startsWith('.update-'));
  /** Version `v` of the extension, with no migrations: only its files matter here. */
  const writeVersion = async (dir: string, v: string) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.version = v;
    rmSync(dir, { recursive: true, force: true });
    await Bun.write(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await Bun.write(
      join(dir, 'engine/index.js'),
      `export default { name: ${JSON.stringify(NAME)}, category: 'fixture', async register() {} };`,
    );
  };
  /** God's row: installed and enabled, `v` (and `sha`) on record. */
  const record = async (v: string, sha = '11'.repeat(32)) => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry
                (name, display_name, is_installed, is_enabled, version, installed_version, installed_sha256)
              VALUES (${NAME}, ${NAME}, true, true, ${v}, ${v}, ${sha})`.execute(db);
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'zv-upboot-'));
    scratch = mkdtempSync(join(tmpdir(), 'zv-upboot-src-'));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    }
    for (const dir of [base, scratch]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('a crash leftover is settled before extensions load', () => {
    const entry = { name: NAME, version: '1.1.0' } as ExtensionCatalogEntry;
    /** 1.0.0 in place, 1.1.0 staged beside it; `swapped` as a crash after `swap()` leaves it. */
    const interrupted = async (swapped: boolean) => {
      for (const e of readdirSync(base)) rmSync(join(base, e), { recursive: true, force: true });
      await writeVersion(join(base, NAME), '1.0.0');
      const staged = await stageExtensionDir(entry, base, async (b) => {
        await writeVersion(join(b, NAME), '1.1.0');
        return { archiveSha256: 'ab'.repeat(32) };
      });
      if (swapped) staged.swap();
      expect(leftovers()).toHaveLength(1);
      return staged;
    };
    const TABLE = 'zv_hello_ext_upboot_new';
    /** 1.1.0's migration committed, and noted, before the crash. */
    const migrated = async (
      staged: { noteMigrations(ids: number[]): void },
      down: string | null,
    ) => {
      await sql.raw(`CREATE TABLE ${TABLE} (id int)`).execute(db);
      const { rows } = await sql<{ id: number }>`
        INSERT INTO zv_migrations (name, down_sql)
        VALUES (${`ext:${NAME}:002_new`}, ${down}) RETURNING id`.execute(db);
      staged.noteMigrations(rows.map((r) => r.id));
    };
    const cleanMigrations = async () => {
      await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    };
    const tableExists = async () =>
      (await sql<{ t: string | null }>`SELECT to_regclass(${TABLE})::text AS t`.execute(db)).rows[0]
        ?.t != null;

    it("after the new version's migration committed: it is undone, then the old version comes back", async () => {
      await cleanMigrations();
      await migrated(await interrupted(true), `DROP TABLE ${TABLE}`);
      await record('1.0.0');
      await sweepUpdateLeftovers(db, base);
      expect(await tableExists()).toBe(false);
      expect(version(join(base, NAME))).toBe('1.0.0');
      expect(leftovers()).toEqual([]);
    });

    it('a migration that cannot be undone keeps the new version and the old one aside', async () => {
      await cleanMigrations();
      await migrated(await interrupted(true), null);
      await record('1.0.0');
      await sweepUpdateLeftovers(db, base);
      expect(await tableExists()).toBe(true);
      expect(version(join(base, NAME))).toBe('1.1.0');
      expect(leftovers()).toHaveLength(1);
      await cleanMigrations();
    });

    it('after the swap, before the update recorded it: the old version comes back', async () => {
      await interrupted(true);
      await record('1.0.0');
      await sweepUpdateLeftovers(db, base);
      expect(version(join(base, NAME))).toBe('1.0.0');
      expect(leftovers()).toEqual([]);
    });

    it('after the update recorded it, before the old files went: the new version stays', async () => {
      await interrupted(true);
      await record('1.1.0');
      await sweepUpdateLeftovers(db, base);
      expect(version(join(base, NAME))).toBe('1.1.0');
      expect(leftovers()).toEqual([]);
    });

    it('the extension directory gone, the old one aside: it comes back', async () => {
      await interrupted(true);
      rmSync(join(base, NAME), { recursive: true, force: true });
      await record('1.0.0');
      await sweepUpdateLeftovers(db, base);
      expect(version(join(base, NAME))).toBe('1.0.0');
      expect(leftovers()).toEqual([]);
    });

    it('before the swap: only the download goes', async () => {
      await interrupted(false);
      await record('1.0.0');
      await sweepUpdateLeftovers(db, base);
      expect(version(join(base, NAME))).toBe('1.0.0');
      expect(leftovers()).toEqual([]);
    });

    it('an update another replica is running keeps its directory', async () => {
      await interrupted(true);
      await record('1.0.0');
      await withExtensionLock(db, NAME, () => sweepUpdateLeftovers(db, base));
      expect(leftovers()).toHaveLength(1);
      expect(version(join(base, NAME))).toBe('1.1.0');
      // Its lock released, the next boot settles it.
      await sweepUpdateLeftovers(db, base);
      expect(version(join(base, NAME))).toBe('1.0.0');
    });

    it('touches nothing it did not stage', async () => {
      await interrupted(false);
      await sweepUpdateLeftovers(db, base); // settles the staged one
      mkdirSync(join(base, '.update-x1y2z3')); // no extension in its name
      mkdirSync(join(base, '.other'));
      await sweepUpdateLeftovers(db, base);
      expect(readdirSync(base).sort()).toEqual(['.other', '.update-x1y2z3', NAME]);
    });

    it('trusts no name spelled otherwise than stageExtensionDir spells it', async () => {
      await interrupted(false);
      await sweepUpdateLeftovers(db, base);
      // `%68ello-ext` decodes to this extension's name; `..` is no extension's.
      const forged = [
        '.update-%68ello-ext.Ab12Cd',
        '.update-..%2Fescape.Ab12Cd',
        '.update-UP.Ab12Cd',
      ];
      for (const f of forged) mkdirSync(join(base, f, '.previous'), { recursive: true });
      await sweepUpdateLeftovers(db, base);
      expect(leftovers().sort()).toEqual([...forged].sort());
      expect(version(join(base, NAME))).toBe('1.0.0');
    });
  });

  describe('two replicas booting onto one shared directory', () => {
    let downloads = 0;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let sha = '';
    let keys = '';

    beforeAll(async () => {
      await writeVersion(join(scratch, 'v2'), '1.1.0');
      const tgz = join(scratch, 'v2.tar.gz');
      expect(await Bun.spawn(['tar', '-czf', tgz, '-C', join(scratch, 'v2'), '.']).exited).toBe(0);
      const archive = new Uint8Array(readFileSync(tgz));
      sha = createHash('sha256').update(archive).digest('hex');
      const kp = await generateKeypair('upboot-test');
      keys = JSON.stringify([await exportTrustedKeyEntry(kp.keyId, kp.publicJwk)]);
      const sigJson = JSON.stringify(await signBundle(archive, kp));
      // The registry both replicas reach, slow enough that both boots overlap it.
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === '/api/extensions/list')
            return Response.json({
              extensions: [{ name: NAME, version: '1.1.0', publisher_tier: 'first-party' }],
            });
          if (path === '/api/revocations') return Response.json({ revocations: [] });
          if (path.endsWith('/download.sig')) return new Response(sigJson);
          if (path.endsWith('/download')) {
            downloads++;
            await Bun.sleep(1500);
            return new Response(archive, { headers: { 'X-Archive-Sha256': sha } });
          }
          return new Response('not found', { status: 404 });
        },
      });
    });

    afterAll(() => server?.stop(true));

    /** A replica's boot: its own process and pool, `loadFromDB` as `loadAll` calls it. */
    const bootReplica = async () => {
      const script = `
        const { initDatabase } = await import(${JSON.stringify(src('../../db/index.js'))});
        const { extensionLoader } = await import(${JSON.stringify(src('../../lib/extensions/extension-loader.js'))});
        const { Hono } = await import('hono');
        const db = await initDatabase();
        extensionLoader.ctx = { db };
        await extensionLoader.loadFromDB(db, new Hono(), []);
        process.exit(0);
      `;
      const proc = Bun.spawn([process.execPath, '-e', script], {
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          DB_POOL_MAX: '2',
          EXTENSIONS_DIR: base,
          REGISTRY_URL: `http://127.0.0.1:${server?.port}`,
          REGISTRY_PUBLIC_KEYS_JSON: keys,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => proc.kill(), 45_000);
      const code = await proc.exited;
      clearTimeout(timer);
      if (code !== 0)
        throw new Error(`replica exited ${code}: ${await new Response(proc.stderr).text()}`);
    };

    it('fetches what the record says once it holds the lock, not what boot read before', async () => {
      for (const e of readdirSync(base)) rmSync(join(base, e), { recursive: true, force: true });
      // Boot reads a digest the update on another replica, holding the lock, then corrects.
      await record('1.1.0', 'ff'.repeat(32));
      downloads = 0;
      const realFetch = globalThis.fetch;
      const saved = {
        dir: process.env.EXTENSIONS_DIR,
        keys: process.env.REGISTRY_PUBLIC_KEYS_JSON,
      };
      process.env.EXTENSIONS_DIR = base;
      process.env.REGISTRY_PUBLIC_KEYS_JSON = keys;
      _resetCatalogCacheForTests();
      clearRevocationCache();
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        return realFetch(
          url.startsWith(REGISTRY_URL)
            ? `http://127.0.0.1:${server?.port}${url.slice(REGISTRY_URL.length)}`
            : input,
          init,
        );
      }) as typeof fetch;
      try {
        const loader = new ExtensionLoader();
        loader.ctx = { db } as never;
        let boot: Promise<void> | undefined;
        await withExtensionLock(db, NAME, async () => {
          boot = loader.loadFromDB(db, new Hono(), []);
          // Boot reads the registry, then queues on this lock: wait for it to queue.
          const held = _lockTailForTests(NAME);
          for (let i = 0; i < 200 && _lockTailForTests(NAME) === held; i++) await Bun.sleep(25);
          expect(_lockTailForTests(NAME)).not.toBe(held);
          await sql`UPDATE zv_extension_registry SET installed_sha256 = ${sha}
                    WHERE name = ${NAME}`.execute(db);
        });
        await boot;
        await loader.unload(NAME).catch(() => undefined);
      } finally {
        globalThis.fetch = realFetch;
        for (const [k, v] of [
          ['EXTENSIONS_DIR', saved.dir],
          ['REGISTRY_PUBLIC_KEYS_JSON', saved.keys],
        ] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        _resetCatalogCacheForTests();
        clearRevocationCache();
      }
      expect(downloads).toBe(1);
      expect(existsSync(join(base, NAME, 'manifest.json'))).toBe(true);
      expect(version(join(base, NAME))).toBe('1.1.0');
    }, 60_000);

    for (const disk of ['behind the record', 'empty'] as const) {
      it(`${disk}: one fetches it, the other finds it fetched`, async () => {
        for (const e of readdirSync(base)) rmSync(join(base, e), { recursive: true, force: true });
        if (disk !== 'empty') await writeVersion(join(base, NAME), '1.0.0');
        await record('1.1.0', sha);
        downloads = 0;
        await Promise.all([bootReplica(), bootReplica()]);
        expect(downloads).toBe(1);
        expect(version(join(base, NAME))).toBe('1.1.0');
        expect(existsSync(join(base, NAME, 'engine/index.js'))).toBe(true);
        expect(leftovers()).toEqual([]);
      }, 60_000);
    }
  });
});

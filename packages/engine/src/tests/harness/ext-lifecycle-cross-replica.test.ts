/**
 * An extension enabled, disabled or uninstalled on ONE replica follows on the
 * OTHERS without a restart.
 *
 * The marketplace routes load or unload the extension on the replica that
 * served the request and nowhere else: every other engine on the same database
 * kept answering 404 for a freshly enabled extension's routes (its loader never
 * imported it), and kept a disabled one loaded — worker, cron and listeners
 * included — until it restarted.
 *
 * The routes now announce `extension.lifecycle` on the realtime bus; a receiver
 * re-reads the registry's instance-wide row and loads or unloads its own copy to
 * match (the migrations are on record already, so none runs twice).
 *
 * Three parts: the receiving side through the bus's dispatcher (any backend),
 * the sending side at the routes, and two real replicas on Valkey — this
 * process is B, a second `bun` process A writes the row and announces it. The
 * last runs only when HARNESS_VALKEY_URL names a reachable Valkey (CI's "Auth on
 * Valkey" step, which fails on a skip).
 *
 * A marketplace extension's bundle lives on the disk of the replica that
 * installed it. The receiver loaded from its own disk and nothing else, so
 * unless the extensions directory was a shared volume, every other replica
 * answered "engine/index.ts not found" and never served it. It now fetches the
 * version on record from the registry through the install path's own
 * `downloadExtension` (pinned digest, declared SHA-256, Ed25519 signature)
 * before loading, and refuses — nothing on disk, nothing loaded — when that
 * fails. "a replica without the bundle" below drives it against a fake registry.
 *
 * A replica that BOOTS (restart, scale-out) after the enable had the same gap:
 * `loadFromDB` read the bundle from disk or skipped it. It fetches the same way
 * now; a fetch that fails skips that extension, records why on its row, and the
 * boot carries on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import {
  _resetCatalogCacheForTests,
  REGISTRY_URL,
} from '../../lib/extensions/extension-download.js';
import {
  _internalForTests as loaderInternals,
  extensionLoader,
} from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { clearRevocationCache } from '../../lib/extensions/revocations.js';
import {
  dispatchToWs,
  EXTENSION_LIFECYCLE_EVENT,
  engineEvents,
  ORIGIN_ID,
  type RealtimeBusMessage,
  realtimeBus,
  ValkeyRealtimeBus,
} from '../../lib/runtime/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const VALKEY = process.env.HARNESS_VALKEY_URL;
const NAME = 'hello-ext';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const src = (p: string) => new URL(p, import.meta.url).pathname;

const msg = (originId: string): RealtimeBusMessage => ({
  originId,
  event: EXTENSION_LIFECYCLE_EVENT,
  collection: NAME,
  timestamp: new Date().toISOString(),
});

d('extension lifecycle on another replica: this one follows', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  let reloads = 0;
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  /** What the other replica's route left in the registry. */
  const setRow = async (enabled: boolean | null) => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    if (enabled === null) return;
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, ${enabled})`.execute(db);
  };

  const unloadHere = () => extensionLoader.unload(NAME).catch(() => undefined);

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-xrepl-life-'));
    process.env.EXTENSIONS_DIR = base;
    // The enable-time tier check reads a cached catalog an earlier file may have filled.
    _resetCatalogCacheForTests();
    cpSync(FIXTURE, join(base, NAME), { recursive: true });
    extensionLoader.ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    // Boot is over once the server has a rebuild to call (index.ts).
    extensionLoader.setReloadCallback(async () => {
      reloads++;
    });
  }, 60_000);

  afterAll(async () => {
    await unloadHere();
    extensionLoader.setReloadCallback(async () => {});
    extensionLoader.ctx = saved.ctx;
    if (saved.extDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = saved.extDir;
    if (db) await setRow(null).catch(() => undefined);
    if (db) await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    // A real load made the extension role usable; the files after this one assume it is not.
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  describe('the receiving side', () => {
    it('loads an extension enabled elsewhere, once, and ignores its own echo', async () => {
      await unloadHere();
      await setRow(true);
      reloads = 0;
      expect(dispatchToWs(msg(ORIGIN_ID))).toBeUndefined();
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
      expect(extensionLoader.isActive(NAME)).toBe(true);
      expect(reloads).toBe(1);
      // Already there: nothing to load, nothing to rebuild.
      await dispatchToWs(msg('replica-a'));
      expect(reloads).toBe(1);
    }, 30_000);

    it('unloads one disabled elsewhere', async () => {
      await setRow(false);
      reloads = 0;
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(false);
      expect(reloads).toBe(1);
    }, 30_000);

    it('one announced while this replica boots is applied once it serves', async () => {
      await unloadHere();
      await setRow(true);
      loaderInternals.clearReloadCallback();
      reloads = 0;
      await dispatchToWs(msg('replica-a'));
      // Boot may have read its load set already; loading beside it would load twice.
      expect(extensionLoader.isActive(NAME)).toBe(false);
      extensionLoader.setReloadCallback(async () => {
        reloads++;
      });
      for (let i = 0; i < 100 && !extensionLoader.isActive(NAME); i++) await Bun.sleep(50);
      expect(extensionLoader.isActive(NAME)).toBe(true);
      expect(reloads).toBe(1);
    }, 30_000);

    // A firm's row overrides the instance row, on or off (activation.ts), so a
    // firm can have it on while god's default is off: its code must stay loaded.
    it('keeps, and loads, one a firm has on while the instance row is off', async () => {
      await setRow(false);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${NAME}, ${NAME}, ${DEFAULT_TENANT_ID}, true, true)`.execute(db);
      await extensionLoader.loadDynamic(NAME, new Hono());
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(true);
      await unloadHere();
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(true);
      // The bus-outage resync asks the same question.
      await unloadHere();
      await extensionLoader.syncAllWithRegistry();
      expect(extensionLoader.isActive(NAME)).toBe(true);
    }, 30_000);

    it('unloads one purged elsewhere (no row left)', async () => {
      await setRow(true);
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(true);
      await setRow(null);
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(false);
    }, 30_000);

    it('the bus-outage resync unloads one purged meanwhile, but not one ZVELTIO_EXTENSIONS lists', async () => {
      await setRow(true);
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(true);
      // Purged while the bus was down: no announcement, no row left.
      await setRow(null);
      const env = process.env.ZVELTIO_EXTENSIONS;
      try {
        process.env.ZVELTIO_EXTENSIONS = NAME;
        await extensionLoader.syncAllWithRegistry();
        expect(extensionLoader.isActive(NAME)).toBe(true);
        process.env.ZVELTIO_EXTENSIONS = '';
        await extensionLoader.syncAllWithRegistry();
        expect(extensionLoader.isActive(NAME)).toBe(false);
      } finally {
        if (env === undefined) delete process.env.ZVELTIO_EXTENSIONS;
        else process.env.ZVELTIO_EXTENSIONS = env;
      }
    }, 30_000);
  });

  describe('the sending side', () => {
    it('enable, disable and uninstall each announce the change', async () => {
      await unloadHere();
      await setRow(null);
      const bus = realtimeBus();
      const publish = bus.publish;
      const sent: string[] = [];
      bus.publish = async (p) => {
        if (p.event === EXTENSION_LIFECYCLE_EVENT) sent.push(`${p.collection}`);
      };
      try {
        for (const action of ['enable', 'disable', 'uninstall']) {
          const r = await engine.request(`/api/marketplace/${NAME}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: god },
            body: '{}',
          });
          expect(`${action} ${r.status}`).toBe(`${action} 200`);
        }
      } finally {
        bus.publish = publish;
      }
      expect(sent).toEqual([NAME, NAME, NAME]);
    }, 30_000);

    // The firm's switch decides whether the code runs anywhere when god's row is
    // off: it loads or unloads here, and the other replicas are told to follow.
    it("a firm's activate and deactivate load, unload and announce", async () => {
      await unloadHere();
      await setRow(false);
      const bus = realtimeBus();
      const publish = bus.publish;
      const sent: string[] = [];
      bus.publish = async (p) => {
        if (p.event === EXTENSION_LIFECYCLE_EVENT) sent.push(`${p.collection}`);
      };
      const post = (action: string) =>
        engine.request(`/api/marketplace/${NAME}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: god },
          body: '{}',
        });
      try {
        expect((await post('activate')).status).toBe(200);
        expect(extensionLoader.isActive(NAME)).toBe(true);
        expect((await post('deactivate')).status).toBe(200);
        expect(extensionLoader.isActive(NAME)).toBe(false);
      } finally {
        bus.publish = publish;
      }
      expect(sent).toEqual([NAME, NAME]);
    }, 30_000);

    it('god disabling the default keeps it loaded while a firm has it on', async () => {
      await unloadHere();
      await setRow(true);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${NAME}, ${NAME}, ${DEFAULT_TENANT_ID}, true, true)`.execute(db);
      await extensionLoader.loadDynamic(NAME, new Hono());
      const r = await engine.request(`/api/marketplace/${NAME}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: '{}',
      });
      expect(r.status).toBe(200);
      expect(extensionLoader.isActive(NAME)).toBe(true);
    }, 30_000);
  });

  (VALKEY ? describe : describe.skip)('two replicas on Valkey', () => {
    // Not the singleton: the harness deleted VALKEY_URL before it was picked.
    const bus = new ValkeyRealtimeBus(VALKEY as string);

    /** Replica A: its own pool and bus; writes the row its route would, then announces. */
    async function onReplicaA(enabled: boolean): Promise<void> {
      const script = `
        const { initDatabase } = await import(${JSON.stringify(src('../../db/index.js'))});
        const rt = await import(${JSON.stringify(src('../../lib/runtime/index.js'))});
        const { sql } = await import('kysely');
        const db = await initDatabase();
        await rt.realtimeBus().start();
        await sql\`UPDATE zv_extension_registry SET is_enabled = ${enabled} WHERE name = ${`'${NAME}'`}\`.execute(db);
        rt.announceExtensionLifecycle(${JSON.stringify(NAME)});
        await Bun.sleep(200);
        process.exit(0);
      `;
      const proc = Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, VALKEY_URL: VALKEY },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const code = await proc.exited;
      if (code !== 0)
        throw new Error(`replica A failed: ${await new Response(proc.stderr).text()}`);
    }

    const until = async (want: boolean) => {
      for (let i = 0; i < 100 && extensionLoader.isActive(NAME) !== want; i++) await Bun.sleep(50);
    };

    beforeAll(async () => {
      await bus.start();
    });
    afterAll(async () => {
      await bus.stop();
    });

    it('B serves what A enabled, and drops what A disabled', async () => {
      await unloadHere();
      await setRow(false);
      await onReplicaA(true);
      await until(true);
      expect(extensionLoader.isActive(NAME)).toBe(true);
      await onReplicaA(false);
      await until(false);
      expect(extensionLoader.isActive(NAME)).toBe(false);
    }, 60_000);
  });

  describe('a replica without the bundle', () => {
    let archive: Uint8Array<ArrayBuffer>;
    let sha = '';
    let sigJson = '';
    const realFetch = globalThis.fetch;
    const savedKeys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
    const downloads: string[] = [];

    /** The registry: catalog, archive (declaring `declared` as its SHA-256) and signature. */
    const serveRegistry = (declared: string, revoked = false) => {
      clearRevocationCache();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(REGISTRY_URL)) return realFetch(input, init);
        if (url.endsWith('/api/extensions/list'))
          return Response.json({
            extensions: [{ name: NAME, version: '1.0.0', publisher_tier: 'first-party' }],
          });
        if (url.endsWith('/api/revocations'))
          return Response.json({
            revocations: revoked
              ? [
                  {
                    name: NAME,
                    version: '1.0.0',
                    reason: 'backdoored',
                    severity: 'critical',
                    advisory_url: null,
                    revoked_at: '2026-10-23T00:00:00Z',
                  },
                ]
              : [],
          });
        if (url.endsWith('/download.sig')) return new Response(sigJson);
        if (url.endsWith('/download')) {
          downloads.push(url);
          return new Response(archive, { headers: { 'X-Archive-Sha256': declared } });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
    };

    /** What replica A's install left in the registry: the version and the digest it pinned. */
    const setInstalledRow = async () => {
      await setRow(true);
      await sql`UPDATE zv_extension_registry
                SET version = '1.0.0', installed_version = '1.0.0', installed_sha256 = ${sha}
                WHERE name = ${NAME}`.execute(db);
    };

    beforeAll(async () => {
      const tgz = join(base, 'bundle.tar.gz');
      const tar = Bun.spawn(['tar', '-czf', tgz, '-C', FIXTURE, '.']);
      expect(await tar.exited).toBe(0);
      archive = new Uint8Array(readFileSync(tgz));
      rmSync(tgz);
      sha = createHash('sha256').update(archive).digest('hex');
      const kp = await generateKeypair('xrepl-fetch');
      process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
        await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
      ]);
      sigJson = JSON.stringify(await signBundle(archive, kp));
    });

    afterAll(() => {
      globalThis.fetch = realFetch;
      if (savedKeys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
      else process.env.REGISTRY_PUBLIC_KEYS_JSON = savedKeys;
      // The fake registry's catalog and revocations must not answer for the files after this one.
      _resetCatalogCacheForTests();
      clearRevocationCache();
    });

    it('fetches the version on record, verifies it, then loads it', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry(sha);
      reloads = 0;
      downloads.length = 0;
      await dispatchToWs(msg('replica-a'));
      expect(downloads).toHaveLength(1);
      expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
      expect(extensionLoader.isActive(NAME)).toBe(true);
      expect(existsSync(join(base, NAME, 'engine/index.js'))).toBe(true);
      expect(reloads).toBe(1);
    }, 30_000);

    it('refuses a bundle that fails its checksum: nothing on disk, nothing loaded', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry('0'.repeat(64));
      reloads = 0;
      downloads.length = 0;
      await dispatchToWs(msg('replica-a'));
      expect(downloads).toHaveLength(1);
      expect(extensionLoader.isActive(NAME)).toBe(false);
      expect(existsSync(join(base, NAME))).toBe(false);
      expect(reloads).toBe(0);
    }, 30_000);

    // Revoked after the enable: the bytes the registry disowns are not fetched, as install refuses them.
    it('refuses a bundle revoked since its enable: nothing fetched, nothing on disk', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry(sha, true);
      reloads = 0;
      downloads.length = 0;
      await dispatchToWs(msg('replica-a'));
      expect(downloads).toHaveLength(0);
      expect(existsSync(join(base, NAME))).toBe(false);
      expect(extensionLoader.isActive(NAME)).toBe(false);
      expect(reloads).toBe(0);
    }, 30_000);

    const lastLoadError = async () =>
      (
        await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                        WHERE name = ${NAME}`.execute(db)
      ).rows[0]?.e ?? null;

    it('a replica booting without it fetches, verifies and loads it', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry(sha);
      downloads.length = 0;
      await extensionLoader.loadFromDB(db, new Hono(), []);
      expect(downloads).toHaveLength(1);
      expect(extensionLoader.isActive(NAME)).toBe(true);
      expect(await lastLoadError()).toBeNull();
    }, 30_000);

    // The version on record lives on god's row, which is off; a firm's row is on.
    it('a replica booting without one only a firm has on fetches and loads it', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      await sql`UPDATE zv_extension_registry SET is_enabled = false WHERE name = ${NAME}`.execute(
        db,
      );
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${NAME}, ${NAME}, ${DEFAULT_TENANT_ID}, true, true)`.execute(db);
      serveRegistry(sha);
      downloads.length = 0;
      await extensionLoader.loadFromDB(db, new Hono(), []);
      expect(downloads).toHaveLength(1);
      expect(extensionLoader.isActive(NAME)).toBe(true);
    }, 30_000);

    it('a boot does not fetch a revoked bundle, and says why', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry(sha, true);
      downloads.length = 0;
      await extensionLoader.loadFromDB(db, new Hono(), []);
      expect(downloads).toHaveLength(0);
      expect(existsSync(join(base, NAME))).toBe(false);
      expect(extensionLoader.isActive(NAME)).toBe(false);
      expect(await lastLoadError()).toContain('REVOKED');
    }, 30_000);

    it('a boot whose fetch fails its checksum skips it, says why, and completes', async () => {
      await unloadHere();
      rmSync(join(base, NAME), { recursive: true, force: true });
      await setInstalledRow();
      serveRegistry('0'.repeat(64));
      downloads.length = 0;
      await extensionLoader.loadFromDB(db, new Hono(), []);
      expect(downloads).toHaveLength(1);
      expect(extensionLoader.isActive(NAME)).toBe(false);
      expect(existsSync(join(base, NAME))).toBe(false);
      expect(await lastLoadError()).toContain('SHA-256 mismatch');
    }, 30_000);
  });
});

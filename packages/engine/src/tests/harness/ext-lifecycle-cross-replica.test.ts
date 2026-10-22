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
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import {
  _internalForTests as loaderInternals,
  extensionLoader,
} from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  dispatchToWs,
  EXTENSION_LIFECYCLE_EVENT,
  engineEvents,
  ORIGIN_ID,
  type RealtimeBusMessage,
  realtimeBus,
  ValkeyRealtimeBus,
} from '../../lib/runtime/index.js';
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

    it('unloads one purged elsewhere (no row left)', async () => {
      await setRow(true);
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(true);
      await setRow(null);
      await dispatchToWs(msg('replica-a'));
      expect(extensionLoader.isActive(NAME)).toBe(false);
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
});

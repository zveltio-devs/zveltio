/**
 * ExtensionLoader.loadFromDB — boot-time reload of enabled registry rows.
 */

import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { CannedDb } from './fixtures/canned-db.js';

const noApp = {} as unknown as Hono;
const REGISTRY_SELECT = /from "zv_extension_registry"/i;
const REGISTRY_UPDATE = /update "zv_extension_registry"/i;

describe('ExtensionLoader.loadFromDB', () => {
  it('loads pending enabled extensions and clears last_load_error on success', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];

    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'ext-a' }, { name: 'ext-b' }]);
    db.whenAffected(REGISTRY_UPDATE, 1);

    const loaded: string[] = [];
    loader.loadExtension = async (name) => {
      loaded.push(name);
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);

    expect(loaded.sort()).toEqual(['ext-a', 'ext-b']);
    const updates = db.executed(REGISTRY_UPDATE);
    expect(updates.length).toBe(2);
    expect(updates.every((q) => q.parameters.includes(null))).toBe(true);
  });

  it('persists last_load_error when an extension fails to activate', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];

    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'broken' }]);
    db.whenAffected(REGISTRY_UPDATE, 1);

    loader.loadExtension = async (name) => {
      loader.lastLoadError.set(name, 'manifest parse error');
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);

    const update = db.executed(REGISTRY_UPDATE)[0]!;
    expect(update.parameters).toContain('manifest parse error');
  });

  it('skips silently when the registry table is missing', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];
    const db = new CannedDb();
    db.fail(REGISTRY_SELECT, new Error('relation does not exist'));

    await expect(
      loader.loadFromDB(db.kysely as unknown as Database, noApp),
    ).resolves.toBeUndefined();
    expect(db.executed(REGISTRY_UPDATE).length).toBe(0);
  });

  it('returns early when every enabled extension is already loaded', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];
    loader.loaded.set('ext-a', { registeredRoutes: false } as never);

    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'ext-a' }]);

    const loadSpy = async () => {
      throw new Error('should not load');
    };
    loader.loadExtension = loadSpy;

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);
    expect(db.executed(REGISTRY_UPDATE).length).toBe(0);
  });

  it('returns early when loader context was never initialized', async () => {
    const loader = new ExtensionLoader();
    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'ext-a' }]);

    loader.loadExtension = async () => {
      throw new Error('should not load');
    };

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);
    expect(db.executed(REGISTRY_SELECT).length).toBe(1);
    expect(db.executed(REGISTRY_UPDATE).length).toBe(0);
  });

  it('persists generic "load failed" when an extension stays inactive without lastLoadError', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];

    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'silent-fail' }]);
    db.whenAffected(REGISTRY_UPDATE, 1);

    loader.loadExtension = async () => {
      // No-op: extension never lands in loaded and no explicit error is recorded.
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);

    const update = db.executed(REGISTRY_UPDATE)[0]!;
    expect(update.parameters).toContain('load failed');
    expect(loader.isActive('silent-fail')).toBe(false);
  });

  it('swallows registry update failures without aborting other extensions', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionLoader['ctx'];

    const db = new CannedDb();
    db.when(REGISTRY_SELECT, [{ name: 'ext-a' }, { name: 'ext-b' }]);
    db.fail(REGISTRY_UPDATE, new Error('update denied'));

    const loaded: string[] = [];
    loader.loadExtension = async (name) => {
      loaded.push(name);
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadFromDB(db.kysely as unknown as Database, noApp);
    expect(loaded.sort()).toEqual(['ext-a', 'ext-b']);
  });
});

/**
 * ExtensionLoader lifecycle helpers — loadDynamic, unload, markActive, dev reload.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

const noApp = {} as unknown as Hono;
let savedNodeEnv: string | undefined;

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe('ExtensionLoader.loadDynamic', () => {
  it('throws when the loader context was never initialized', async () => {
    const loader = new ExtensionLoader();
    await expect(loader.loadDynamic('missing-ctx', noApp)).rejects.toThrow(/not initialized/i);
  });

  it('throws the persisted last_load_error when activation fails', async () => {
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;
    loader.loadExtension = async (name) => {
      loader.lastLoadError.set(name, 'manifest parse error');
    };
    await expect(loader.loadDynamic('broken-ext', noApp)).rejects.toThrow(/manifest parse error/);
  });
});

describe('ExtensionLoader.unload', () => {
  it('runs cleanup and reports needs_restart when routes were registered', async () => {
    const loader = new ExtensionLoader();
    let cleaned = false;
    loader.loaded.set('ext', {
      name: 'ext',
      registeredRoutes: true,
      cleanup: async () => {
        cleaned = true;
      },
    } as never);
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;

    const result = await loader.unload('ext');
    expect(cleaned).toBe(true);
    expect(result.unloaded).toBe(true);
    expect(result.needs_restart).toBe(true);
    expect(loader.isActive('ext')).toBe(false);
  });

  it('returns a friendly message when the extension is not loaded', async () => {
    const loader = new ExtensionLoader();
    const result = await loader.unload('never-loaded');
    expect(result.unloaded).toBe(false);
    expect(result.message).toMatch(/not loaded/i);
  });
});

describe('ExtensionLoader introspection helpers', () => {
  it('exposes active names, manifest meta, and last load errors', () => {
    const loader = new ExtensionLoader();
    loader.markActive('active-one');
    loader.manifestMeta.set('active-one', { version: '2.0.0' } as never);
    loader.lastLoadError.set('failed-one', 'boom');

    expect(loader.isActive('active-one')).toBe(true);
    expect(loader.getActive()).toEqual(['active-one']);
    expect(loader.getLastLoadError('failed-one')).toBe('boom');
    expect(loader.getExtensionMeta()[0]).toMatchObject({ name: 'active-one', version: '2.0.0' });
  });
});

describe('ExtensionLoader.registerDevEndpoints', () => {
  it('mounts POST /__zveltio_dev_reload outside production', async () => {
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    const { Hono } = await import('hono');
    const app = new Hono();
    const loader = new ExtensionLoader();
    loader.reloadExtensionFromDisk = async () => ({ ok: true });
    loader.registerDevEndpoints(app);

    const bad = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(bad.status).toBe(400);

    const missing = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const ok = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hello-ext' }),
    });
    expect(ok.status).toBe(200);
  });
});

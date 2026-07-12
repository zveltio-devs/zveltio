/**
 * ExtensionLoader class thin delegators — reRegisterExtension + reloadExtensionFromDisk.
 * Hits extension-loader.ts delegator lines not covered when calling lifecycle/register directly.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('ExtensionLoader class delegators', () => {
  it('reRegisterExtension mounts cached routes on a fresh app', async () => {
    const loader = new ExtensionLoader();
    const extension: ZveltioExtension = {
      name: 'cls-rereg',
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub) {
        sub.get('/ping', (c) => c.text('pong'));
      },
    };
    loader.modules.set('cls-rereg', extension);
    loader.loaded.set('cls-rereg', {
      name: 'cls-rereg',
      registeredRoutes: true,
      allowedTables: new Set(),
    } as never);
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;

    const app = new Hono();
    await loader.reRegisterExtension('cls-rereg', app);
    const res = await app.request('/ext/cls-rereg/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('reloadExtensionFromDisk clears state and reports success', async () => {
    serviceRegistry.registerAs('cls-reload', 'reloadMarker', { ok: true });
    const loader = new ExtensionLoader();
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;
    loader.modules.set('cls-reload', {
      name: 'cls-reload',
      category: 'custom',
      register: async () => {},
    });
    loader.loaded.set('cls-reload', { name: 'cls-reload' } as never);
    loader.loadExtension = async () => {};
    loader.isActive = () => true;

    const result = await loader.reloadExtensionFromDisk('cls-reload');
    expect(result.ok).toBe(true);
    expect(loader.modules.has('cls-reload')).toBe(false);
    expect(serviceRegistry.has('reloadMarker')).toBe(false);
  });
});

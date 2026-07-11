/**
 * Unit coverage for lib/extensions/register.ts — allowed-tables scan,
 * restricted context wiring, finalizeExtensionLoad, reRegisterExtension.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import {
  EXTENSION_TABLE_GRANTS,
  buildAllowedTables,
  buildRestrictedContext,
  finalizeExtensionLoad,
  reRegisterExtension,
} from '../../lib/extensions/register.js';
import * as workerExtensionHost from '../../lib/worker-extension-host.js';
import { cronRunner } from '../../lib/runtime/index.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(over: Record<string, unknown> = {}): ExtensionLoader {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    modules: new Map<string, ZveltioExtension>(),
    lastLoadError: new Map(),
    ctx: { db: db.kysely } as unknown as ExtensionContext,
    ...over,
  } as unknown as ExtensionLoader;
}

function baseCtx(): ExtensionContext {
  const db = new CannedDb();
  return { db: db.kysely } as unknown as ExtensionContext;
}

describe('buildAllowedTables', () => {
  it('extracts CREATE TABLE names from migration SQL files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const mig = join(dir, '001.sql');
    writeFileSync(
      mig,
      `CREATE TABLE IF NOT EXISTS zv_probe_items (id uuid primary key);
       CREATE TABLE zv_probe_tags (id uuid primary key);`,
    );
    const tables = await buildAllowedTables([mig]);
    expect(tables.has('zv_probe_items')).toBe(true);
    expect(tables.has('zv_probe_tags')).toBe(true);
  });

  it('skips unreadable migration paths', async () => {
    const tables = await buildAllowedTables(['/no/such/migration.sql']);
    expect(tables.size).toBe(0);
  });
});

describe('EXTENSION_TABLE_GRANTS', () => {
  it('declares explicit table grants for known extensions', () => {
    expect(EXTENSION_TABLE_GRANTS['content/drafts']).toContain('zv_revisions');
    expect(EXTENSION_TABLE_GRANTS['developer/validation']).toContain('zv_validation_rules');
  });
});

describe('buildRestrictedContext', () => {
  it('mounts registerPublicRoute on the global app for supported methods', () => {
    const app = new Hono();
    app.get('/health', (c) => c.text('ok'));
    const ctx = buildRestrictedContext(baseCtx(), 'pub-ext', app, new Set(), true);
    ctx.registerPublicRoute?.({
      method: 'GET',
      path: '/ext-public/ping',
      handler: (c) => c.text('pong'),
    });
    // Unsupported methods are ignored (no throw).
    ctx.registerPublicRoute?.({
      method: 'TRACE' as 'GET',
      path: '/ext-public/trace',
      handler: () => new Response('nope'),
    });
    expect(typeof ctx.services).toBe('object');
    expect(typeof ctx.onHealthCheck).toBe('function');
  });
});

describe('finalizeExtensionLoad', () => {
  afterEach(() => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = undefined;
  });

  it('registers a subapp-mounted extension under /ext/<name>', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const app = new Hono();
    const loader = fakeLoader();
    const extension: ZveltioExtension = {
      name: 'subapp-ext',
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, _ctx) {
        sub.get('/hello', (c) => c.text('hi'));
      },
    };
    await finalizeExtensionLoad(
      loader,
      extension,
      'subapp-ext',
      '/tmp/subapp-ext',
      app,
      loader.ctx!,
      { name: 'subapp-ext', version: '1.0.0', category: 'custom' } as never,
      new Set(['zv_subapp_ext_items']),
    );
    expect(loader.loaded.has('subapp-ext')).toBe(true);
    const res = await app.request('/ext/subapp-ext/hello');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi');
  });

  it('registers a global-mounted extension directly on the host app', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const app = new Hono();
    const loader = fakeLoader();
    const extension: ZveltioExtension = {
      name: 'global-ext',
      category: 'custom',
      mountStrategy: 'global',
      async register(sub, _ctx) {
        sub.get('/global/ping', (c) => c.text('pong'));
      },
    };
    await finalizeExtensionLoad(
      loader,
      extension,
      'global-ext',
      '/tmp/global-ext',
      app,
      loader.ctx!,
      { name: 'global-ext', version: '1.0.0', category: 'custom' } as never,
      new Set(),
    );
    const res = await app.request('/global/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('delegates to WorkerExtensionHost when isolation=worker', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const startMock = mock(async () => {});
    const hostSpy = spyOn(workerExtensionHost, 'getWorkerHost').mockReturnValue({
      start: startMock,
    } as never);
    try {
      const app = new Hono();
      const loader = fakeLoader();
      const extension: ZveltioExtension = {
        name: 'worker-ext',
        category: 'custom',
        async register() {},
      };
      await finalizeExtensionLoad(
        loader,
        extension,
        'worker-ext',
        '/tmp/worker-ext',
        app,
        loader.ctx!,
        {
          name: 'worker-ext',
          version: '1.0.0',
          engine: { bundled: true, isolation: 'worker', entry: 'engine/index.js' },
        } as never,
        new Set(),
      );
      expect(startMock).toHaveBeenCalled();
    } finally {
      hostSpy.mockRestore();
    }
  });

  it('registers cron schedules from extension.schedules()', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const registerSpy = spyOn(cronRunner, 'register').mockImplementation(() => {});
    try {
      const app = new Hono();
      const loader = fakeLoader();
      const extension: ZveltioExtension = {
        name: 'sched-ext',
        category: 'custom',
        mountStrategy: 'subapp',
        schedules: () => [{ name: 'tick', cron: '* * * * *', handler: async () => {} }],
        async register() {},
      };
      await finalizeExtensionLoad(
        loader,
        extension,
        'sched-ext',
        '/tmp/sched-ext',
        app,
        loader.ctx!,
        { name: 'sched-ext', version: '1.0.0' } as never,
        new Set(),
      );
      expect(registerSpy).toHaveBeenCalled();
    } finally {
      registerSpy.mockRestore();
    }
  });
});

describe('reRegisterExtension', () => {
  it('no-ops when the module is not cached', async () => {
    const loader = fakeLoader();
    const app = new Hono();
    await reRegisterExtension(loader, 'ghost', app);
    expect(loader.loaded.size).toBe(0);
  });

  it('re-mounts routes from the cached module on a fresh app', async () => {
    const loader = fakeLoader();
    const extension: ZveltioExtension = {
      name: 'reload-ext',
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub) {
        sub.get('/v', (c) => c.text('v2'));
      },
    };
    loader.modules.set('reload-ext', extension);
    loader.loaded.set('reload-ext', {
      name: 'reload-ext',
      registeredRoutes: true,
      allowedTables: new Set(),
    });
    const app = new Hono();
    await reRegisterExtension(loader, 'reload-ext', app);
    const res = await app.request('/ext/reload-ext/v');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('v2');
  });
});

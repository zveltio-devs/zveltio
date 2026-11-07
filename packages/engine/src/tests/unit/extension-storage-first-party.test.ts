/**
 * The `storage` capability hands an extension the instance's S3 keys
 * (`ctx.config.objectStorage`). Owner, 2026-11-07: only first-party extensions
 * get them, until storage/cloud moves to an engine file API and the capability
 * is retired.
 *
 * First-party is the tier the publisher-tier gate verified, never the name: an
 * extension loads inline only when the catalog says first-party
 * (`enforcePublisherTier`); every other one runs in a worker. A third party may
 * publish as `storage/evil` (the registry reserves no namespace), declare
 * `storage`, and get operator consent. Its worker received the keys at init,
 * because `postMessage` clones the config getter's value.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { finalizeExtensionLoad, reRegisterExtension } from '../../lib/extensions/register.js';
import * as workerExtensionHost from '../../lib/worker-extension-host.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const ENV = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'STORAGE_DRIVER'] as const;
let saved: Record<string, string | undefined>;
let wasInline = false;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.S3_ENDPOINT = 'https://s3.example.com';
  process.env.S3_ACCESS_KEY = 'AKIA_INSTANCE';
  process.env.S3_SECRET_KEY = 'instance-secret';
  delete process.env.STORAGE_DRIVER;
  wasInline = _setInlineForTests(true);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _setInlineForTests(wasInline);
});

function fakeLoader(): ExtensionLoader {
  return {
    loaded: new Map(),
    modules: new Map<string, ZveltioExtension>(),
    lastLoadError: new Map(),
    extDirs: new Map(),
    forgetExtensionMessages: () => {},
    // No consent row: every declared capability is effective (grandfathered),
    // the same as an operator who approved `storage`.
    ctx: { db: new CannedDb().kysely } as unknown as ExtensionContext,
  } as unknown as ExtensionLoader;
}

describe('storage credentials go to first-party extensions only', () => {
  it('a worker (not first-party) extension declaring storage gets no keys at worker init', async () => {
    let source: { config?: unknown } | undefined;
    const hostSpy = spyOn(workerExtensionHost, 'getWorkerHost').mockReturnValue({
      isRunning: () => false,
      stop: mock(async () => {}),
      start: mock(async (...args: unknown[]) => {
        source = args[5] as { config?: unknown };
      }),
    } as never);
    try {
      const loader = fakeLoader();
      await finalizeExtensionLoad(
        loader,
        { name: 'storage/evil', category: 'storage', async register() {} },
        'storage/evil',
        '/tmp/storage-evil',
        new Hono(),
        loader.ctx!,
        {
          name: 'storage/evil',
          version: '1.0.0',
          permissions: ['storage'],
          engine: { bundled: true, isolation: 'worker', entry: 'engine/index.js' },
        } as never,
        new Set(),
      );
      expect(source).toBeDefined();
      // What the worker actually receives: the init message is cloned.
      const posted = structuredClone(source!.config) as { objectStorage?: unknown };
      expect(posted.objectStorage).toBeUndefined();
      expect(JSON.stringify(posted)).not.toContain('instance-secret');
    } finally {
      hostSpy.mockRestore();
    }
  });

  it('nor after a hot-reload re-registers it', async () => {
    let source: { config?: unknown } | undefined;
    const hostSpy = spyOn(workerExtensionHost, 'getWorkerHost').mockReturnValue({
      isRunning: () => false,
      remount: () => false,
      stop: mock(async () => {}),
      start: mock(async (...args: unknown[]) => {
        source = args[5] as { config?: unknown };
      }),
    } as never);
    try {
      const loader = fakeLoader();
      loader.modules.set('storage/evil', {
        name: 'storage/evil',
        category: 'storage',
        async register() {},
      });
      loader.loaded.set('storage/evil', {
        name: 'storage/evil',
        registeredRoutes: true,
        permissions: ['storage'],
        workerIsolation: { entry: 'engine/index.js', extDir: '/tmp/storage-evil' },
      } as never);
      await reRegisterExtension(loader, 'storage/evil', new Hono());
      expect(source).toBeDefined();
      const posted = structuredClone(source!.config) as { objectStorage?: unknown };
      expect(posted.objectStorage).toBeUndefined();
    } finally {
      hostSpy.mockRestore();
    }
  });

  it('an inline (first-party) extension declaring storage keeps them', async () => {
    let ctxSeen: ExtensionContext | undefined;
    const loader = fakeLoader();
    await finalizeExtensionLoad(
      loader,
      {
        name: 'storage/cloud',
        category: 'storage',
        async register(_app, ctx) {
          ctxSeen = ctx as unknown as ExtensionContext;
        },
      },
      'storage/cloud',
      '/tmp/storage-cloud',
      new Hono(),
      loader.ctx!,
      { name: 'storage/cloud', version: '1.1.13', permissions: ['storage'] } as never,
      new Set(),
    );
    expect(ctxSeen?.config?.objectStorage?.secretAccessKey).toBe('instance-secret');
  });
});

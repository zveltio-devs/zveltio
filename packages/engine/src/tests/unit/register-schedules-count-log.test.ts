/**
 * finalizeExtensionLoad — schedule registration success log (register.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import { cronRunner } from '../../lib/runtime/index.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(): ExtensionLoader {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    modules: new Map<string, ZveltioExtension>(),
    lastLoadError: new Map(),
    ctx: { db: db.kysely } as unknown as ExtensionContext,
  } as unknown as ExtensionLoader;
}

afterEach(() => {
  process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = undefined;
  cronRunner.unregisterAll('sched-ok');
});

describe('finalizeExtensionLoad — schedules success log', () => {
  it('logs how many schedules were registered when schedules() returns entries', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const registerSpy = spyOn(cronRunner, 'register').mockImplementation(() => {});
    try {
      const app = new Hono();
      const loader = fakeLoader();
      const extension: ZveltioExtension = {
        name: 'sched-ok',
        category: 'custom',
        mountStrategy: 'subapp',
        schedules: () => [
          { name: 'tick-a', intervalMs: 30_000, handler: async () => {} },
          { name: 'tick-b', intervalMs: 60_000, handler: async () => {} },
        ],
        async register(sub) {
          sub.get('/ok', (c) => c.text('ok'));
        },
      };
      await finalizeExtensionLoad(
        loader,
        extension,
        'sched-ok',
        '/tmp/sched-ok',
        app,
        loader.ctx!,
        { name: 'sched-ok', version: '1.0.0' } as never,
        new Set(),
      );
      expect(registerSpy).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.some((c) => String(c[0]).includes('registered 2 schedule(s)'))).toBe(
        true,
      );
    } finally {
      log.mockRestore();
      registerSpy.mockRestore();
    }
  });
});

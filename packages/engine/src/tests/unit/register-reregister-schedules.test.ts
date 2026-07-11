/**
 * reRegisterExtension — cron schedule re-registration on hot-reload (register.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { reRegisterExtension } from '../../lib/extensions/register.js';
import { cronRunner } from '../../lib/runtime/index.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(extension: ZveltioExtension): ExtensionLoader {
  const db = new CannedDb();
  return {
    loaded: new Map([
      [
        'sched-ext',
        { name: 'sched-ext', registeredRoutes: true, allowedTables: new Set<string>() },
      ],
    ]),
    modules: new Map([['sched-ext', extension]]),
    lastLoadError: new Map(),
    ctx: { db: db.kysely } as unknown as ExtensionContext,
  } as unknown as ExtensionLoader;
}

afterEach(() => {
  cronRunner.unregisterAll('sched-ext');
});

describe('reRegisterExtension — schedules', () => {
  it('unregisters old schedules and registers fresh definitions from schedules()', async () => {
    const registerSpy = spyOn(cronRunner, 'register').mockImplementation(() => {});
    const unregisterSpy = spyOn(cronRunner, 'unregisterAll').mockReturnValue(1);
    try {
      const extension: ZveltioExtension = {
        name: 'sched-ext',
        category: 'custom',
        mountStrategy: 'subapp',
        schedules: () => [{ name: 'tick', intervalMs: 30_000, handler: async () => {} }],
        async register(sub) {
          sub.get('/ping', (c) => c.text('ok'));
        },
      };
      const loader = fakeLoader(extension);
      const app = new Hono();
      await reRegisterExtension(loader, 'sched-ext', app);
      expect(unregisterSpy).toHaveBeenCalledWith('sched-ext');
      expect(registerSpy).toHaveBeenCalled();
      const res = await app.request('/ext/sched-ext/ping');
      expect(res.status).toBe(200);
    } finally {
      registerSpy.mockRestore();
      unregisterSpy.mockRestore();
    }
  });

  it('warns and continues when schedules() throws on hot-reload', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const extension: ZveltioExtension = {
        name: 'sched-ext',
        category: 'custom',
        mountStrategy: 'subapp',
        schedules: () => {
          throw new Error('schedules boom');
        },
        async register(sub) {
          sub.get('/x', (c) => c.text('x'));
        },
      };
      const loader = fakeLoader(extension);
      await reRegisterExtension(loader, 'sched-ext', new Hono());
      expect(warn.mock.calls.some((c) => String(c[0]).includes('schedules() threw'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

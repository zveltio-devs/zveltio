/**
 * buildRestrictedContext + finalizeExtensionLoad edge branches (register.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { buildRestrictedContext, finalizeExtensionLoad } from '../../lib/extensions/register.js';
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

afterEach(() => {
  process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = undefined;
});

describe('buildRestrictedContext — db:admin capability', () => {
  it('exposes adminDb that accepts zvd_ tables when db:admin is declared', () => {
    const ctx = buildRestrictedContext(
      baseCtx(),
      'admin-ext',
      new Hono(),
      new Set(['zvd_contacts']),
      false,
      ['db:admin'],
    );
    expect(ctx.adminDb).toBeDefined();
    expect(() => ctx.adminDb?.selectFrom('zvd_contacts' as never)).not.toThrow();
  });

  it('logs public route mount failures without throwing', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const app = new Hono();
    spyOn(app, 'get').mockImplementation(() => {
      throw new Error('route mount failed');
    });
    try {
      const ctx = buildRestrictedContext(baseCtx(), 'pub-ext', app, new Set(), true);
      ctx.registerPublicRoute?.({
        method: 'GET',
        path: '/bad',
        handler: () => new Response('ok'),
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('public route'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('finalizeExtensionLoad — deferred matcher + schedule errors', () => {
  it('still marks loaded when route registration hits a built matcher', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const app = new Hono();
    const loader = fakeLoader();
    const extension: ZveltioExtension = {
      name: 'defer-ext',
      category: 'custom',
      mountStrategy: 'subapp',
      async register() {
        throw new Error('matcher is already built');
      },
    };
    await finalizeExtensionLoad(
      loader,
      extension,
      'defer-ext',
      '/tmp/defer-ext',
      app,
      loader.ctx!,
      { name: 'defer-ext', version: '1.0.0' } as never,
      new Set(),
    );
    expect(loader.loaded.has('defer-ext')).toBe(true);
  });

  it('warns and continues when schedules() throws', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const registerSpy = spyOn(cronRunner, 'register').mockImplementation(() => {});
    try {
      const app = new Hono();
      const loader = fakeLoader();
      const extension: ZveltioExtension = {
        name: 'sched-bad',
        category: 'custom',
        mountStrategy: 'subapp',
        schedules: () => {
          throw new Error('bad schedules');
        },
        async register(sub) {
          sub.get('/ok', (c) => c.text('ok'));
        },
      };
      await finalizeExtensionLoad(
        loader,
        extension,
        'sched-bad',
        '/tmp/sched-bad',
        app,
        loader.ctx!,
        { name: 'sched-bad', version: '1.0.0' } as never,
        new Set(),
      );
      expect(loader.loaded.has('sched-bad')).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('schedules()'))).toBe(true);
      expect(registerSpy).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      registerSpy.mockRestore();
    }
  });
});

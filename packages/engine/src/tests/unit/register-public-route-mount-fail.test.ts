/**
 * buildRestrictedContext — registerPublicRoute catches mount failures (register.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function baseCtx(): ExtensionContext {
  return { db: new CannedDb().kysely } as unknown as ExtensionContext;
}

describe('buildRestrictedContext — registerPublicRoute mount failure', () => {
  it('warns and continues when mounting a public route throws', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const app = new Hono();
    const origGet = app.get.bind(app);
    app.get = ((path: string, _handler: unknown) => {
      if (path === '/public/boom') throw new Error('matcher already built');
      return origGet(path, _handler as never);
    }) as typeof app.get;

    try {
      const ctx = buildRestrictedContext(baseCtx(), 'pub-ext', app, new Set(), false);
      ctx.registerPublicRoute?.({
        method: 'GET',
        path: '/public/boom',
        handler: (c) => c.text('never'),
      });
      expect(
        warn.mock.calls.some(
          (c) =>
            String(c[0]).includes('public route GET /public/boom failed') &&
            String(c[1]).includes('matcher already built'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

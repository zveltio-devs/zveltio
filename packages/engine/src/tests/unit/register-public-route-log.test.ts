/**
 * buildRestrictedContext — successful public route registration log (register.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function baseCtx(): ExtensionContext {
  return { db: new CannedDb().kysely } as unknown as ExtensionContext;
}

describe('buildRestrictedContext — registerPublicRoute success log', () => {
  it('logs when a public route is mounted and logPublicRoute is enabled', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const app = new Hono();
    try {
      const ctx = buildRestrictedContext(baseCtx(), 'pub-ext', app, new Set(), true);
      ctx.registerPublicRoute?.({
        method: 'GET',
        path: '/public/ping',
        handler: (c) => c.text('pong'),
      });
      expect(log.mock.calls.some((c) => String(c[0]).includes('registered public route'))).toBe(
        true,
      );
    } finally {
      log.mockRestore();
    }
  });
});

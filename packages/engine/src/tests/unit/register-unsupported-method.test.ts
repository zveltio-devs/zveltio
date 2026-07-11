/**
 * buildRestrictedContext — unsupported public route HTTP methods (register.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function baseCtx(): ExtensionContext {
  return { db: new CannedDb().kysely } as unknown as ExtensionContext;
}

describe('buildRestrictedContext — registerPublicRoute', () => {
  it('skips unsupported HTTP methods with a warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = buildRestrictedContext(baseCtx(), 'pub-ext', new Hono(), new Set(), false);
      ctx.registerPublicRoute?.({
        method: 'TRACE' as 'GET',
        path: '/trace',
        handler: () => new Response('nope'),
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('unsupported HTTP method'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

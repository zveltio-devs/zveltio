/**
 * finalizeExtensionLoad — non-matcher register errors propagate (register.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
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
});

describe('finalizeExtensionLoad — register failure', () => {
  it('rethrows register errors that are not the built-matcher deferral', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const loader = fakeLoader();
    const extension: ZveltioExtension = {
      name: 'boom-ext',
      category: 'custom',
      mountStrategy: 'subapp',
      async register() {
        throw new Error('register exploded');
      },
    };
    await expect(
      finalizeExtensionLoad(
        loader,
        extension,
        'boom-ext',
        '/tmp/boom-ext',
        new Hono(),
        loader.ctx!,
        { name: 'boom-ext', version: '1.0.0' } as never,
        new Set(),
      ),
    ).rejects.toThrow('register exploded');
    expect(loader.loaded.has('boom-ext')).toBe(false);
  });
});

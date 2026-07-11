/**
 * reRegisterExtension failure path (lib/extensions/register.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { reRegisterExtension } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(extension: ZveltioExtension): ExtensionLoader {
  const db = new CannedDb();
  return {
    loaded: new Map([
      [
        'boom-ext',
        { name: 'boom-ext', registeredRoutes: true, allowedTables: new Set(), permissions: [] },
      ],
    ]),
    modules: new Map([['boom-ext', extension]]),
    lastLoadError: new Map(),
    ctx: { db: db.kysely } as unknown as ExtensionContext,
  } as unknown as ExtensionLoader;
}

describe('reRegisterExtension — register failure', () => {
  it('logs and swallows errors from registerExtensionRoutes', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const extension: ZveltioExtension = {
      name: 'boom-ext',
      category: 'custom',
      mountStrategy: 'subapp',
      async register() {
        throw new Error('hot reload register failed');
      },
    };
    const loader = fakeLoader(extension);
    const app = new Hono();
    await reRegisterExtension(loader, 'boom-ext', app);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Hot-reload'))).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[1]).includes('hot reload register failed'))).toBe(
      true,
    );
    errSpy.mockRestore();
  });
});

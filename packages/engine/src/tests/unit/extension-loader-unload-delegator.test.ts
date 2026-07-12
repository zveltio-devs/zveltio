/**
 * ExtensionLoader.unload — thin delegator to lifecycle (extension-loader.ts).
 */

import { describe, expect, it } from 'bun:test';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('ExtensionLoader.unload delegator', () => {
  it('unloads without needs_restart when no routes were registered', async () => {
    const loader = new ExtensionLoader();
    loader.loaded.set('plain-ext', {
      name: 'plain-ext',
      registeredRoutes: false,
    } as never);
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;

    const result = await loader.unload('plain-ext');
    expect(result.unloaded).toBe(true);
    expect(result.needs_restart).toBe(false);
    expect(loader.isActive('plain-ext')).toBe(false);
  });
});

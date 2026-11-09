/**
 * A retired first-party extension is never loaded, whichever way it is asked
 * for. Migrations 110, 111 and 114 removed the registry rows, but a name in
 * ZVELTIO_EXTENSIONS skips the registry, and an extensions directory kept
 * across the upgrade still holds the 1.x bundle.
 */
import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { loadExtensionFromDir, RETIRED_EXTENSIONS } from '../../lib/extensions/load.js';

describe('retired extensions', () => {
  it('refuses to load each one, saying the engine serves it', async () => {
    for (const name of Object.keys(RETIRED_EXTENSIONS)) {
      const lastLoadError = new Map<string, string>();
      const loader = { lastLoadError } as unknown as ExtensionLoader;
      // A directory that does not exist: the refusal comes before any file is read.
      await loadExtensionFromDir(loader, name, {} as Hono, {} as ExtensionContext, '/nonexistent');
      expect(lastLoadError.get(name)).toStartWith(`retired: ${RETIRED_EXTENSIONS[name]}`);
    }
  });
});

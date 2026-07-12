/**
 * enforcePublisherTier — catalog fetch failure without ZVELTIO_REQUIRE_CATALOG falls through.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { enforcePublisherTier } from '../../lib/extensions/load-phases.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';

let savedRequire: string | undefined;

afterEach(() => {
  if (savedRequire === undefined) delete process.env.ZVELTIO_REQUIRE_CATALOG;
  else process.env.ZVELTIO_REQUIRE_CATALOG = savedRequire;
});

describe('enforcePublisherTier — catalog fetch fallback', () => {
  it('allows inline when the catalog fetch fails and REQUIRE_CATALOG is unset', async () => {
    savedRequire = process.env.ZVELTIO_REQUIRE_CATALOG;
    delete process.env.ZVELTIO_REQUIRE_CATALOG;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('registry offline'),
    );
    try {
      const r = await enforcePublisherTier('sideloaded', {
        name: 'sideloaded',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

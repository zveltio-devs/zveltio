/**
 * ADR 0056 / LV-05: relabelling one's own extension first-party in a catalogue
 * override file ran it inline, in the engine process — the only way LV-05 found
 * to run a private extension. An override lists what can be installed, never who
 * published it: only the catalogue compiled into the engine (or the registry)
 * makes a name first-party. An operator's own code is signed with an operator
 * key instead, and runs on the runner. Since ADR 0062 d1 an unlisted name runs
 * on the runner anyway; the override must still confer no level 0 there (d2).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCatalogForTests } from '../../lib/extensions/extension-catalog.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { _setInlineForTests, enforcePublisherTier } from '../../lib/extensions/load-phases.js';

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  displayName: name,
  description: 'x',
  category: 'custom',
  version: '1.0.0',
  author: 'Operator',
  tags: [],
  permissions: [],
  ...extra,
});

describe('a catalogue override cannot make an extension first-party (ADR 0056)', () => {
  let dir = '';
  afterEach(() => {
    delete process.env.ZVELTIO_CATALOG_PATH;
    _resetCatalogForTests();
    _resetCatalogCacheForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('confers no first-party tier on the runner; a bundled first-party name still has it (ADR 0062 d2)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zv-relabel-'));
    const path = join(dir, 'catalog.json');
    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          entry('acme/relabelled', { is_official: true, publisher_tier: 'first-party' }),
          entry('acme/default-official'),
          entry('crm'),
        ],
      }),
    );
    process.env.ZVELTIO_CATALOG_PATH = path;
    _resetCatalogForTests();
    _resetCatalogCacheForTests();
    _setInlineForTests(false);
    // The registry is unreachable: the local catalogue is all there is.
    const net = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      // Every name off the inline list runs as a worker (ADR 0062 d1); "*" asks
      // for the first-party tier, which only the compiled catalogue gives.
      const star = (name: string) =>
        enforcePublisherTier(
          name,
          {
            name,
            version: '1.0.0',
            engine: { entry: 'engine/index.js', bundled: true },
            actions: [{ name: 'peek', reads: ['*'], writes: [] }],
          } as never,
          null,
          true,
        );
      const relabelled = await star('acme/relabelled');
      expect(relabelled.ok).toBe(false);
      expect(relabelled.ok ? '' : relabelled.lastLoadError).toMatch(/no verified first-party tier/);
      expect((await star('acme/default-official')).ok).toBe(false);
      const crm = await star('crm');
      expect(crm.ok && crm.value.firstParty).toBe(true);
    } finally {
      net.mockRestore();
    }
  });
});

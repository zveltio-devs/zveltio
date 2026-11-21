/**
 * ADR 0056 / LV-05: relabelling one's own extension first-party in a catalogue
 * override file ran it inline, in the engine process — the only way LV-05 found
 * to run a private extension. An override lists what can be installed, never who
 * published it: only the catalogue compiled into the engine (or the registry)
 * makes a name first-party. An operator's own code is signed with an operator
 * key instead, and runs on the runner.
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

  it('runs a relabelled private extension inline no more; a bundled first-party name still does', async () => {
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
      const inline = (name: string) =>
        enforcePublisherTier(name, { name, version: '1.0.0' } as never, null, true);
      const relabelled = await inline('acme/relabelled');
      expect(relabelled.ok).toBe(false);
      expect(relabelled.ok ? '' : relabelled.lastLoadError).toMatch(/community/);
      // The way it does run, named in the refusal (ADR 0056 s4).
      expect(relabelled.ok ? '' : relabelled.lastLoadError).toMatch(
        /sign it with a key on OPERATOR_PUBLIC_KEYS_JSON .*level 3 — docs\/extensions\/signatures\.md#your-own-extensions-level-3/,
      );
      expect((await inline('acme/default-official')).ok).toBe(false);
      expect((await inline('crm')).ok).toBe(true);
    } finally {
      net.mockRestore();
    }
  });
});

/**
 * load.ts — malformed early manifest.json falls through to the full load path.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader() {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map(),
    ctx: {
      db: db.kysely,
      fieldTypeRegistry: { register: () => {} },
    } as unknown as ExtensionContext,
  };
}

describe('loadExtensionFromDir — early manifest parse failure', () => {
  it('continues loading when the early manifest read throws', async () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-early-fall-'));
    const extDir = join(base, 'broken-early');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'manifest.json'), '{not json');
    // No engine bundle — full path should surface missing bundle, not crash.
    const loader = fakeLoader();
    await loadExtensionFromDir(
      loader as unknown as ExtensionLoader,
      'broken-early',
      new Hono(),
      loader.ctx,
      base,
    );
    expect(loader.loaded.has('broken-early')).toBe(false);
    expect(loader.modules.has('broken-early')).toBe(false);
  });
});

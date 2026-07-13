/**
 * load.ts — continues past missing engine/index.js when engine/index.ts exists (dev).
 */

import { afterEach, describe, expect, it } from 'bun:test';
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

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir — dev TypeScript entry only', () => {
  it('does not warn-and-return when only engine/index.ts is present', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const base = mkdtempSync(join(tmpdir(), 'zv-ts-only-'));
    const extDir = join(base, 'ts-only');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        name: 'ts-only',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.ts' },
      }),
    );
    writeFileSync(
      join(extDir, 'engine/index.ts'),
      `export default {
        name: 'ts-only',
        mountStrategy: 'subapp',
        async register(app) { app.get('/ping', (c) => c.text('ts')); },
      };`,
    );

    const loader = fakeLoader();
    await loadExtensionFromDir(
      loader as unknown as ExtensionLoader,
      'ts-only',
      new Hono(),
      loader.ctx,
      base,
    );
    expect(loader.loaded.has('ts-only')).toBe(true);
    expect(loader.lastLoadError.get('ts-only')).toBeUndefined();
  });
});

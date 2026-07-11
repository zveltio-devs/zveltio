/**
 * loadExtensionFromDir — malformed early manifest falls through to engine load.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(): any {
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

describe('loadExtensionFromDir — malformed early manifest', () => {
  it('falls through when the early manifest.json is invalid JSON', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const base = mkdtempSync(join(tmpdir(), 'zv-bad-manifest-'));
    const extName = 'bad-json';
    const extDir = join(base, extName);
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(join(extDir, 'manifest.json'), '{ not valid json');
    writeFileSync(
      join(extDir, 'engine/index.js'),
      `export default {
        name: '${extName}',
        mountStrategy: 'subapp',
        async register() {},
      };`,
    );

    const loader = fakeLoader();
    const app = new Hono();
    await loadExtensionFromDir(loader, extName, app, loader.ctx, base);
    expect(loader.lastLoadError.get(extName)).toMatch(/manifest|json|parse/i);
  });
});

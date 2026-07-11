/**
 * loadExtensionFromDir — EXTENSION_TABLE_GRANTS merged into allowedTables.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-grant-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal loader stub
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

const app = new Hono();

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir — table grants', () => {
  it('merges EXTENSION_TABLE_GRANTS into allowedTables for known extensions', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const migDir = mkdtempSync(join(tmpdir(), 'zv-mig-grant-'));
    const migPath = join(migDir, '001.sql');
    writeFileSync(migPath, 'CREATE TABLE zv_drafts_items (id uuid);');

    const base = tmpExt({
      'content/drafts/manifest.json': JSON.stringify({
        name: 'content/drafts',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js' },
      }),
      'content/drafts/engine/index.js': `
        export default {
          name: 'content/drafts',
          mountStrategy: 'subapp',
          getMigrations() { return [${JSON.stringify(migPath)}]; },
          async register(sub) {
            sub.get('/ok', (c) => c.text('ok'));
          },
        };
      `,
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'content/drafts', app, loader.ctx, base);
    const loaded = loader.loaded.get('content/drafts');
    expect(loaded?.allowedTables?.has('zv_drafts_items')).toBe(true);
    expect(loaded?.allowedTables?.has('zv_revisions')).toBe(true);
  });
});

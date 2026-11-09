/**
 * loadExtensionFromDir — two installed names that fold to one `zv_<ext>_`
 * prefix (`a-b`, `a_b`) would own each other's tables, env keys and grants.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

function extDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-twin-'));
  const files: Record<string, string> = {
    [`${name}/manifest.json`]: JSON.stringify({
      name,
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js' },
    }),
    [`${name}/engine/index.js`]: `export default { name: ${JSON.stringify(name)}, async register() {} };`,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function fakeLoader(installed: string[]): any {
  const db = new CannedDb();
  db.when(/zv_extension_registry/, () => installed.map((name) => ({ name })));
  return {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map(),
    extDirs: new Map(),
    forgetExtensionMessages: () => {},
    ctx: {
      db: db.kysely,
      fieldTypeRegistry: { register: () => {} },
    } as unknown as ExtensionContext,
  };
}

afterEach(() => {
  _setInlineForTests(false);
});

describe('loadExtensionFromDir — prefix twins', () => {
  it('refuses an extension whose prefix another installed name also folds to', async () => {
    _setInlineForTests(true);
    const loader = fakeLoader(['a-b', 'a_b']);
    await loadExtensionFromDir(loader, 'a-b', new Hono(), loader.ctx, extDir('a-b'));
    expect(loader.loaded.has('a-b')).toBe(false);
    expect(loader.lastLoadError.get('a-b')).toContain('"a_b"');
  });

  it('loads it when no other installed name shares the prefix', async () => {
    _setInlineForTests(true);
    const loader = fakeLoader(['a-b', 'a', 'a-b-c']);
    await loadExtensionFromDir(loader, 'a-b', new Hono(), loader.ctx, extDir('a-b'));
    expect(loader.lastLoadError.get('a-b')).toBeUndefined();
    expect(loader.loaded.has('a-b')).toBe(true);
  });
});

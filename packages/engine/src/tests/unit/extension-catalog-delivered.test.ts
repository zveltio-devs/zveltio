/**
 * The catalogue is delivered data now, not a TypeScript array compiled into the
 * engine. What that has to buy is one thing: an operator can change what their
 * instance offers without rebuilding anything. These tests are that promise.
 *
 * The bundled copy still has to work with no file and no registry, because an
 * isolated install is the target deployment — so the fallback is pinned too.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_CATALOG_VERSION,
  _resetCatalogForTests,
  getExtensionCatalog,
} from '../../lib/extensions/extension-catalog.js';

const roots: string[] = [];
function tempCatalog(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-catalog-'));
  roots.push(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'catalog.json');
  writeFileSync(path, contents);
  return path;
}

const ONE_ENTRY = JSON.stringify({
  catalog_version: 'test',
  entries: [
    {
      name: 'only-this-one',
      displayName: 'Only This One',
      description: 'Replaces the bundled catalogue entirely.',
      category: 'custom',
      version: '9.9.9',
      author: 'Operator',
      tags: [],
      permissions: [],
    },
  ],
});

describe('the delivered catalogue', () => {
  afterEach(() => {
    delete process.env.ZVELTIO_CATALOG_PATH;
    delete process.env.EXTENSIONS_DIR;
    _resetCatalogForTests();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('falls back to the bundled copy when there is no file anywhere', () => {
    _resetCatalogForTests();
    const catalog = getExtensionCatalog();
    expect(catalog.length).toBeGreaterThan(50);
    expect(catalog.some((e) => e.name === 'hello-ext')).toBe(true);
    expect(BUNDLED_CATALOG_VERSION).not.toBe('unknown');
  });

  it('is replaced by a file the operator points at', () => {
    process.env.ZVELTIO_CATALOG_PATH = tempCatalog(ONE_ENTRY);
    _resetCatalogForTests();
    const catalog = getExtensionCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe('only-this-one');
  });

  it('is replaced by catalog.json sitting in the extensions directory', () => {
    const path = tempCatalog(ONE_ENTRY);
    process.env.EXTENSIONS_DIR = join(path, '..');
    _resetCatalogForTests();
    expect(getExtensionCatalog()).toHaveLength(1);
  });

  it('prefers the explicit path over the extensions directory', () => {
    const explicit = tempCatalog(ONE_ENTRY);
    const other = tempCatalog(
      JSON.stringify({ entries: [{ ...JSON.parse(ONE_ENTRY).entries[0], name: 'the-other' }] }),
    );
    process.env.ZVELTIO_CATALOG_PATH = explicit;
    process.env.EXTENSIONS_DIR = join(other, '..');
    _resetCatalogForTests();
    expect(getExtensionCatalog()[0]?.name).toBe('only-this-one');
  });

  describe('a file that is not a catalogue', () => {
    // Falling back is right; falling back QUIETLY is not. An operator who edited
    // a file and saw no change has nothing to go on otherwise.
    const cases: Array<[string, string]> = [
      ['is not JSON at all', '{ nope'],
      ['has no entries array', JSON.stringify({ catalog_version: 'x' })],
      ['has an entry missing a name', JSON.stringify({ entries: [{ displayName: 'x' }] })],
    ];

    for (const [what, contents] of cases) {
      it(`says so, and keeps the bundled catalogue, when it ${what}`, () => {
        const said: string[] = [];
        const original = console.warn;
        console.warn = (...a: unknown[]) => {
          said.push(a.map(String).join(' '));
        };
        try {
          process.env.ZVELTIO_CATALOG_PATH = tempCatalog(contents);
          _resetCatalogForTests();
          const catalog = getExtensionCatalog();
          expect(catalog.length).toBeGreaterThan(50);
          expect(said.some((l) => l.includes('[extension-catalog]'))).toBe(true);
        } finally {
          console.warn = original;
        }
      });
    }
  });

  it('every bundled entry carries what a reader needs', () => {
    _resetCatalogForTests();
    for (const e of getExtensionCatalog()) {
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
      expect(typeof e.displayName).toBe('string');
      expect(typeof e.category).toBe('string');
      expect(typeof e.version).toBe('string');
    }
  });
});

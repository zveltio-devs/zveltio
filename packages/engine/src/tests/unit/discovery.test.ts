/**
 * Extension discovery/ordering (lib/extensions/discovery.ts) — the topological
 * sort that boots dependencies before dependents, and the active-set env parse.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveExtensionNames, topoSortExtensions } from '../../lib/extensions/discovery.js';

/** Build a base dir with `<name>/manifest.json` declaring the given deps. */
function baseWith(specs: Record<string, string[]>): string {
  const base = mkdtempSync(join(tmpdir(), 'zv-disco-'));
  for (const [name, deps] of Object.entries(specs)) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(
      join(base, name, 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: deps.map((d) => ({ name: d })) }),
    );
  }
  return base;
}

describe('topoSortExtensions', () => {
  it('returns 0- or 1-element inputs unchanged (fast path)', async () => {
    expect(await topoSortExtensions([], '/nope')).toEqual([]);
    expect(await topoSortExtensions(['solo'], '/nope')).toEqual(['solo']);
  });

  it('orders a dependency before its dependent', async () => {
    const base = baseWith({ a: ['b'], b: [] });
    const sorted = await topoSortExtensions(['a', 'b'], base);
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('a'));
    expect(sorted.sort()).toEqual(['a', 'b']);
  });

  it('resolves a longer chain a→b→c', async () => {
    const base = baseWith({ a: ['b'], b: ['c'], c: [] });
    const sorted = await topoSortExtensions(['a', 'b', 'c'], base);
    expect(sorted).toEqual(['c', 'b', 'a']);
  });

  it('refuses a cycle and whatever depends on it, and sorts the rest', async () => {
    const base = baseWith({ a: ['b'], b: ['a'], c: ['a'], d: [] });
    const refused = new Map<string, string>();
    expect(await topoSortExtensions(['a', 'b', 'c', 'd'], base, refused)).toEqual(['d']);
    expect(refused.get('a')).toBe('Circular extension dependency: a -> b -> a');
    expect(refused.get('b')).toBe('Circular extension dependency: a -> b -> a');
    expect(refused.get('c')).toContain('depends on "a"');
  });

  it('tolerates a dependency that is not in the load set (warns, still loads)', async () => {
    const base = baseWith({ a: ['ghost'], b: [] });
    const sorted = await topoSortExtensions(['a', 'b'], base);
    expect(sorted.sort()).toEqual(['a', 'b']);
  });

  it('treats a missing manifest as no dependencies', async () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-disco-'));
    const sorted = await topoSortExtensions(['x', 'y'], base);
    expect(sorted.sort()).toEqual(['x', 'y']);
  });
});

describe('getActiveExtensionNames', () => {
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.ZVELTIO_EXTENSIONS;
    else process.env.ZVELTIO_EXTENSIONS = v;
  };

  it('parses a comma list, trimming blanks', () => {
    const prev = process.env.ZVELTIO_EXTENSIONS;
    try {
      set('crm, mail ,, pos ');
      expect(getActiveExtensionNames()).toEqual(['crm', 'mail', 'pos']);
      set(undefined);
      expect(getActiveExtensionNames()).toEqual([]);
    } finally {
      set(prev);
    }
  });
});

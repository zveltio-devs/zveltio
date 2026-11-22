import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionDirListing } from '../publish/dir.js';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('extensionDirListing: a root node_modules/', () => {
  it('is left out of the operator listing, links and all, and nowhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dir-listing-'));
    try {
      mkdirSync(join(dir, 'engine'));
      writeFileSync(join(dir, 'manifest.json'), '{"name":"x"}');
      writeFileSync(join(dir, 'engine', 'index.js'), 'export default {}');
      const clean = text(extensionDirListing(dir, 'x', 'private', { operator: true }));

      // What `bun install` leaves: the dependency tree and its .bin links.
      mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
      mkdirSync(join(dir, 'node_modules', '.bin'));
      writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1');
      symlinkSync('../dep/index.js', join(dir, 'node_modules', '.bin', 'dep'));
      const files = new Map<string, string>();
      expect(text(extensionDirListing(dir, 'x', 'private', { operator: true, files }))).toBe(clean);
      expect([...files.keys()].sort()).toEqual(['engine/index.js', 'manifest.json']);

      // A download's listing (which may run inline) still covers it: the link refuses.
      expect(() => extensionDirListing(dir, 'x', '')).toThrow(/a link is never signed/);
      rmSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      expect(text(extensionDirListing(dir, 'x', ''))).toContain(' node_modules/dep/index.js\n');

      // Only the root one: a node_modules/ elsewhere is signed like any directory.
      mkdirSync(join(dir, 'engine', 'node_modules'));
      writeFileSync(join(dir, 'engine', 'node_modules', 'a.js'), '');
      expect(text(extensionDirListing(dir, 'x', 'private', { operator: true }))).toContain(
        ' engine/node_modules/a.js\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

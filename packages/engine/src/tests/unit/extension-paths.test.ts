/**
 * extension-paths.ts — base resolution + on-disk presence checks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  extensionFilesPresent,
  extensionFilesPresentCached,
  invalidateFilesPresent,
  resolveExtensionsBase,
} from '../../lib/extensions/extension-paths.js';

let extDir: string;
let savedExtensionsDir: string | undefined;

beforeEach(() => {
  extDir = mkdtempSync(join(tmpdir(), 'zv-ext-paths-'));
  savedExtensionsDir = process.env.EXTENSIONS_DIR;
});

afterEach(() => {
  if (savedExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtensionsDir;
  invalidateFilesPresent();
  try {
    rmSync(extDir, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('resolveExtensionsBase', () => {
  it('prefers EXTENSIONS_DIR when set', () => {
    process.env.EXTENSIONS_DIR = '/custom/extensions';
    expect(resolveExtensionsBase()).toBe('/custom/extensions');
  });
});

describe('extensionFilesPresent', () => {
  it('detects engine/index.ts', () => {
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(join(extDir, 'engine', 'index.ts'), 'export default {}');
    expect(extensionFilesPresent(extDir)).toBe(true);
  });

  it('detects engine/index.js', () => {
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(join(extDir, 'engine', 'index.js'), 'module.exports = {}');
    expect(extensionFilesPresent(extDir)).toBe(true);
  });

  it('detects an alternate engine entry from manifest.engine.routes', () => {
    const routesDir = join(extDir, 'server');
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, 'routes.ts'), 'export default {}');
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ engine: { routes: './server/routes.ts' } }),
    );
    expect(extensionFilesPresent(extDir)).toBe(true);
  });

  it('treats UI-only extensions as present when manifest declares no engine', () => {
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'pdf-viewer', contributes: { engine: false } }),
    );
    expect(extensionFilesPresent(extDir)).toBe(true);
  });

  it('returns false for a malformed manifest', () => {
    writeFileSync(join(extDir, 'manifest.json'), '{ not json');
    expect(extensionFilesPresent(extDir)).toBe(false);
  });

  it('returns false when manifest routes point at a missing engine file', () => {
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ engine: { routes: './server/missing.ts' } }),
    );
    expect(extensionFilesPresent(extDir)).toBe(false);
  });

  it('invalidateFilesPresent() without an argument clears the whole cache', () => {
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(join(extDir, 'engine', 'index.ts'), 'export default {}');
    expect(extensionFilesPresentCached(extDir)).toBe(true);
    invalidateFilesPresent();
    rmSync(join(extDir, 'engine'), { recursive: true, force: true });
    expect(extensionFilesPresentCached(extDir)).toBe(false);
  });

  it('caches presence for a few seconds', () => {
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(join(extDir, 'engine', 'index.ts'), 'export default {}');
    expect(extensionFilesPresentCached(extDir)).toBe(true);
    rmSync(join(extDir, 'engine'), { recursive: true, force: true });
    expect(extensionFilesPresentCached(extDir)).toBe(true);
    invalidateFilesPresent(extDir);
    expect(extensionFilesPresentCached(extDir)).toBe(false);
  });
});

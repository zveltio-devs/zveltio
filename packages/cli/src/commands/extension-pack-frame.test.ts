import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionPackCommand } from './extension-pack.js';

/** ADR 0038: a page's `frame` must name a built file inside `ui/` at pack time. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(frame: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-pack-frame-'));
  dirs.push(dir);
  const pages = [{ path: '/admin/x', label: 'X', frame }];
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', studio: { pages } }),
  );
  mkdirSync(join(dir, 'ui', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'index.html'), '<!doctype html>');
  symlinkSync(join(dir, 'manifest.json'), join(dir, 'ui', 'escape.html'));
  return dir;
}

describe('extension pack — frames', () => {
  it('packs a document-only extension whose frame is a file in ui/', async () => {
    await extensionPackCommand({ dir: fixture('index.html') });
  });

  it('refuses a frame that is missing, a directory, or outside ui/', async () => {
    for (const frame of ['missing.html', 'sub', '../manifest.json', 'escape.html']) {
      await expect(extensionPackCommand({ dir: fixture(frame) })).rejects.toThrow(
        'is not a file under ui/',
      );
    }
  });
});

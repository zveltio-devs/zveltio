/**
 * resolveManifest — missing extension dependencies branch (load-phases.ts).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../../lib/extensions/load-phases.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-ext-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('resolveManifest — extension dependencies', () => {
  it('fails when a declared dependency extension is not enabled', async () => {
    const canned = new CannedDb();
    canned.when(/from "zv_extension_registry"/i, []);
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'child-ext',
        version: '1.0.0',
        dependencies: [{ name: 'parent-ext' }],
      }),
    });
    const r = await resolveManifest('child-ext', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastLoadError).toContain('parent-ext');
      expect(r.logLevel).toBe('warn');
    }
  });
});

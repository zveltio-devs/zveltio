/**
 * resolveManifest — contributes + description land in manifestMeta (load-phases.ts).
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../../lib/extensions/load-phases.js';
import type { Database } from '../../db/index.js';

const db = {} as Database;

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-contrib-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('resolveManifest — manifestMeta payload', () => {
  it('includes contributes and description for Studio metadata', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'contrib-ext',
        version: '1.0.0',
        displayName: 'Contrib Ext',
        description: 'Adds a sidebar widget',
        category: 'analytics',
        contributes: { widgets: [{ id: 'w1', title: 'KPI' }] },
      }),
    });
    const r = await resolveManifest('contrib-ext', dir, db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifestMeta?.displayName).toBe('Contrib Ext');
      expect(r.value.manifestMeta?.description).toBe('Adds a sidebar widget');
      expect(r.value.manifestMeta?.category).toBe('analytics');
      expect(r.value.manifestMeta?.contributes?.engine).toBe(true);
    }
  });
});

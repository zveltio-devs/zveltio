/**
 * resolveManifest — pg_extension lookup failure is non-fatal (load-phases.ts).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../../lib/extensions/load-phases.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-pgext-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('resolveManifest — postgres extensions', () => {
  it('continues when the pg_extension probe query throws', async () => {
    const db = new CannedDb();
    db.when(/pg_extension/i, () => {
      throw new Error('permission denied for pg_extension');
    });
    const dir = tmpExt({
      name: 'probe',
      version: '1.0.0',
      requires: { postgres_extensions: ['postgis'] },
    });
    const r = await resolveManifest('probe', dir, db.kysely as unknown as Database);
    expect(r.ok).toBe(true);
  });
});

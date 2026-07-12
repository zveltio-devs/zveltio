/**
 * resolveManifest — missing PostgreSQL extension fails the phase (load-phases.ts).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../../lib/extensions/load-phases.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-pgmiss-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('resolveManifest — missing postgres extensions', () => {
  it('fails when a required extension is not installed', async () => {
    const db = new CannedDb();
    db.when(/pg_extension/i, [{ extname: 'plpgsql' }]);
    const dir = tmpExt({
      name: 'probe',
      version: '1.0.0',
      requires: { postgres_extensions: ['postgis'] },
    });
    const r = await resolveManifest('probe', dir, db.kysely as unknown as Database);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.logLevel).toBe('warn');
      expect(r.lastLoadError).toContain('postgis');
      expect(r.lastLoadError).toContain('CREATE EXTENSION');
    }
  });
});

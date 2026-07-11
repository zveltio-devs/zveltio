/**
 * resolveEntryPath — bundled entry missing on disk (load-phases.ts).
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';

describe('resolveEntryPath — bundled entry', () => {
  it('fails when engine.bundled=true but engine.entry is absent from disk', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'zv-bund-miss-'));
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    const enginePath = join(extDir, 'engine/index.js');
    const r = await resolveEntryPath('packed-ext', extDir, enginePath, {
      name: 'packed-ext',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js' },
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastLoadError).toContain('engine.bundled=true');
      expect(r.logLevel).toBe('error');
    }
  });
});

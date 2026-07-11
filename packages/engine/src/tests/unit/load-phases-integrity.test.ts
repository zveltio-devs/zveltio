/**
 * resolveEntryPath bundled integrity success (lib/extensions/load-phases.ts).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-int-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('resolveEntryPath — integrity hash', () => {
  it('accepts a bundled entry when engineSha256 matches the on-disk bytes', async () => {
    const body = 'export default { async register(){} };';
    const hash = createHash('sha256').update(body).digest('hex');
    const extDir = tmpExt({ 'engine/index.js': body });
    const entry = join(extDir, 'engine/index.js');
    const r = await resolveEntryPath('probe', extDir, entry, {
      name: 'probe',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js' },
      integrity: { engineSha256: hash },
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(entry);
  });
});

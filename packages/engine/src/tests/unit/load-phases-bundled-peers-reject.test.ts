/**
 * resolveEntryPath — bundled extensions must inline peerDependencies (load-phases.ts).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';

describe('resolveEntryPath — bundled peers without bundlePeers', () => {
  it('rejects peerDependencies when engine.bundlePeers is not true', async () => {
    const body = 'export default { async register(){} };';
    const hash = createHash('sha256').update(body).digest('hex');
    const extDir = mkdtempSync(join(tmpdir(), 'zv-bund-peers-bad-'));
    const entry = join(extDir, 'engine/index.js');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(entry, body);

    const r = await resolveEntryPath('packed', extDir, entry, {
      name: 'packed',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js' },
      peerDependencies: { imapflow: '^1.0.0' },
      integrity: { engineSha256: hash },
    } as never);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastLoadError).toContain('bundlePeers');
      expect(r.lastLoadError).toContain('imapflow');
      expect(r.logLevel).toBe('error');
    }
  });
});

/**
 * resolveEntryPath — bundled extensions with inlined peers succeed (load-phases.ts).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';

describe('resolveEntryPath — bundled peers inlined', () => {
  it('accepts peerDependencies when engine.bundlePeers is true', async () => {
    const body = 'export default { async register(){} };';
    const hash = createHash('sha256').update(body).digest('hex');
    const extDir = mkdtempSync(join(tmpdir(), 'zv-bund-peers-'));
    const entry = join(extDir, 'engine/index.js');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(entry, body);

    const r = await resolveEntryPath('packed', extDir, entry, {
      name: 'packed',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js', bundlePeers: true },
      peerDependencies: { imapflow: '^1.0.0' },
      integrity: { engineSha256: hash },
    } as never);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(entry);
  });
});

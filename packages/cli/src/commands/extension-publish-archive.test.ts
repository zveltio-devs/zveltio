/**
 * ADR 0056 s4: `zveltio extension publish` leaves the operator's own
 * `signature.json` out of the archive — it signs a directory for one engine, and
 * the registry signs what it serves — and only at the root: a schema file of
 * that name deeper down is the extension's own and ships.
 */

import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internalForTests } from './extension-publish.js';

it('archives everything but the root signature.json and the usual excludes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zv-publish-'));
  try {
    const dir = join(root, 'ext');
    mkdirSync(join(dir, 'schema'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'signature.json'), '{"tier":"private"}');
    writeFileSync(join(dir, 'schema', 'signature.json'), '{}');
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '');
    const out = join(root, 'ext.zvext');
    await _internalForTests.createArchive(dir, out);
    const listed = Bun.spawnSync(['tar', '-tzf', out]).stdout.toString().split('\n');
    expect(listed).toContain('./manifest.json');
    expect(listed).toContain('./schema/signature.json');
    expect(listed).not.toContain('./signature.json');
    expect(listed.some((p) => p.includes('node_modules'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

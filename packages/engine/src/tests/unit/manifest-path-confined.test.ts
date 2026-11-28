/**
 * A path a manifest names stays inside the extension's directory (DR-TASKS
 * l.58). The signature covers the files under that directory only, so
 * `studio.pages[].schema` or `engine.entry` reaching outside it (`..`, an
 * absolute path) would read or import a file nobody signed.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';
import { embedPageSchemas } from '../../lib/extensions/manifest-schema.js';

function layout(): { extDir: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'zv-mpath-'));
  const extDir = join(root, 'ext');
  mkdirSync(join(extDir, 'studio'), { recursive: true });
  mkdirSync(join(extDir, 'engine'), { recursive: true });
  writeFileSync(join(extDir, 'engine', 'index.js'), 'export default {};');
  writeFileSync(join(extDir, 'studio', 'ok.json'), JSON.stringify({ title: 'ok' }));
  const outside = join(root, 'secret.json');
  writeFileSync(outside, JSON.stringify({ secret: 'not signed' }));
  writeFileSync(join(root, 'evil.js'), 'export default {};');
  return { extDir, outside };
}

describe('manifest-named paths are confined to the extension directory', () => {
  it('a page schema naming a file outside the directory is not read or served', async () => {
    const { extDir, outside } = layout();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await embedPageSchemas(extDir, {
        pages: [
          { path: '/up', label: 'Up', schema: '../../secret.json' },
          { path: '/abs', label: 'Abs', schema: outside },
          { path: '/ok', label: 'Ok', schema: 'ok.json' },
        ],
      });
      expect(out?.pages?.[0]?.schema).toBeUndefined();
      expect(out?.pages?.[1]?.schema).toBeUndefined();
      expect(out?.pages?.[2]?.schema).toEqual({ title: 'ok' });
      expect(JSON.stringify(out)).not.toContain('not signed');
    } finally {
      warn.mockRestore();
    }
  });

  it('an engine.entry outside the directory refuses the load', async () => {
    const { extDir } = layout();
    for (const entry of ['../evil.js', join(extDir, '..', 'evil.js')]) {
      const r = await resolveEntryPath('mpath', extDir, join(extDir, 'engine/index.js'), {
        name: 'mpath',
        version: '1.0.0',
        engine: { bundled: true, entry },
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('outside');
    }
    const ok = await resolveEntryPath('mpath', extDir, join(extDir, 'engine/index.js'), {
      name: 'mpath',
      version: '1.0.0',
      engine: { bundled: true, entry: 'engine/index.js' },
    } as never);
    expect(ok.ok).toBe(true);
  });
});

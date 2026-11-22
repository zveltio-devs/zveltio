/**
 * resolveEntryPath — production refuses unbundled legacy .ts extensions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';

let savedNodeEnv: string | undefined;
let savedDevReload: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedDevReload = process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedDevReload === undefined) delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
  else process.env.ZVELTIO_EXTENSION_DEV_RELOAD = savedDevReload;
});

describe('resolveEntryPath — production gate', () => {
  it('rejects unbundled extensions in production without dev reload', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;

    const extDir = mkdtempSync(join(tmpdir(), 'zv-prod-ext-'));
    const jsPath = join(extDir, 'engine/index.js');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(jsPath, 'export default {}');

    const r = await resolveEntryPath('legacy', extDir, jsPath, {
      name: 'legacy',
      version: '1.0.0',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastLoadError).toContain('not bundled');
      expect(r.logLevel).toBe('error');
    }
  });

  // A development switch, not a production one: lifted in production it loaded
  // an unbundled extension whose core deps resolve from the shared, unsigned
  // <EXTENSIONS_DIR>/node_modules, inside the engine.
  it('still rejects them in production when ZVELTIO_EXTENSION_DEV_RELOAD=1', async () => {
    delete process.env.NODE_ENV;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';

    const extDir = mkdtempSync(join(tmpdir(), 'zv-prod-ext-'));
    const jsPath = join(extDir, 'engine/index.js');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(jsPath, 'export default {}');

    const r = await resolveEntryPath('legacy', extDir, jsPath, {
      name: 'legacy',
      version: '1.0.0',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('not bundled');
  });
});

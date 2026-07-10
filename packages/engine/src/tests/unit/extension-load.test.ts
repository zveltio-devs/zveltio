/**
 * Unit coverage for lib/extensions/load.ts — loadExtensionFromDir orchestration
 * (Studio-only short-circuit, missing engine bundle, manifest/tier failures).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal loader stub
function fakeLoader(): any {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map(),
    ctx: {
      db: db.kysely,
      fieldTypeRegistry: { register: () => {} },
    } as unknown as ExtensionContext,
  };
}

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-load-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const app = new Hono();

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir', () => {
  it('short-circuits Studio/client-only extensions (contributes.engine: false)', async () => {
    const base = tmpExt({
      'studio-only/manifest.json': JSON.stringify({
        name: 'studio-only',
        version: '1.0.0',
        displayName: 'Studio Only',
        contributes: { engine: false },
      }),
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'studio-only', app, loader.ctx, base);
    expect(loader.loaded.get('studio-only')?.registeredRoutes).toBe(false);
    expect(loader.manifestMeta.get('studio-only')?.displayName).toBe('Studio Only');
    expect(loader.lastLoadError.size).toBe(0);
  });

  it('warns and returns when no engine bundle exists', async () => {
    const base = tmpExt({
      'no-engine/manifest.json': JSON.stringify({ name: 'no-engine', version: '1.0.0' }),
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'no-engine', app, loader.ctx, base);
    expect(loader.loaded.has('no-engine')).toBe(false);
    expect(loader.modules.has('no-engine')).toBe(false);
  });

  it('records lastLoadError when manifest is engine-incompatible', async () => {
    const base = tmpExt({
      'bad-compat/manifest.json': JSON.stringify({
        name: 'bad-compat',
        version: '1.0.0',
        zveltioMinVersion: '999.0.0',
      }),
      'bad-compat/engine/index.js': 'export default { async register(){} };',
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'bad-compat', app, loader.ctx, base);
    expect(loader.loaded.has('bad-compat')).toBe(false);
  });

  it('records lastLoadError when wasm runtime is declared but .wasm is missing', async () => {
    const base = tmpExt({
      'wasm-miss/manifest.json': JSON.stringify({
        name: 'wasm-miss',
        version: '1.0.0',
        runtime: 'wasm',
      }),
      'wasm-miss/engine/index.js': 'export default {};',
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'wasm-miss', app, loader.ctx, base);
    expect(loader.lastLoadError.get('wasm-miss')).toContain('extension.wasm is missing');
  });

  it('loads a bundled inline extension when inline third-party override is set', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const base = tmpExt({
      'inline-probe/manifest.json': JSON.stringify({
        name: 'inline-probe',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js' },
      }),
      'inline-probe/engine/index.js': `
        export default {
          name: 'inline-probe',
          mountStrategy: 'subapp',
          async register(app) {
            app.get('/ok', (c) => c.text('loaded'));
          },
        };
      `,
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'inline-probe', app, loader.ctx, base);
    expect(loader.loaded.has('inline-probe')).toBe(true);
    expect(loader.modules.has('inline-probe')).toBe(true);
    const res = await app.request('/ext/inline-probe/ok');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('loaded');
  });
});

/**
 * loadExtensionFromDir — registerFieldTypes + table grants (lib/extensions/load.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-ft-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal loader stub
function fakeLoader(): any {
  const registered: string[] = [];
  const db = new CannedDb();
  return {
    loaded: new Map(),
    manifestMeta: new Map(),
    modules: new Map(),
    lastLoadError: new Map(),
    ctx: {
      db: db.kysely,
      fieldTypeRegistry: {
        register: (t: { name: string }) => registered.push(t.name),
      },
    } as unknown as ExtensionContext,
    _registered: registered,
  };
}

const app = new Hono();

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir — field types', () => {
  it('calls registerFieldTypes on the shared field type registry', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const base = tmpExt({
      'ft-ext/manifest.json': JSON.stringify({
        name: 'ft-ext',
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js' },
      }),
      'ft-ext/engine/index.js': `
        export default {
          name: 'ft-ext',
          mountStrategy: 'subapp',
          registerFieldTypes(registry) {
            registry.register({ name: 'flow_color', type: 'text' });
          },
          async register(sub) {
            sub.get('/ping', (c) => c.text('pong'));
          },
        };
      `,
    });
    const loader = fakeLoader();
    await loadExtensionFromDir(loader, 'ft-ext', app, loader.ctx, base);
    expect(loader._registered).toEqual(['flow_color']);
    expect(loader.loaded.has('ft-ext')).toBe(true);
  });
});

/**
 * load.ts — load failure audit log rejection is non-fatal (outer catch).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import * as audit from '../../lib/audit.js';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(): ExtensionLoader {
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
  } as unknown as ExtensionLoader;
}

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-load-audit-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
});

describe('loadExtensionFromDir — audit on load failure', () => {
  it('records lastLoadError when import fails even if the failure audit log rejects', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const auditSpy = spyOn(audit, 'auditLog').mockRejectedValue(new Error('audit unavailable'));
    try {
      const base = tmpExt({
        'audit-fail/manifest.json': JSON.stringify({
          name: 'audit-fail',
          version: '1.0.0',
          engine: { bundled: true, entry: 'engine/index.js' },
        }),
        'audit-fail/engine/index.js': 'throw new Error("load blew up");',
      });
      const loader = fakeLoader();
      await loadExtensionFromDir(loader, 'audit-fail', new Hono(), loader.ctx!, base);
      expect(loader.lastLoadError.get('audit-fail')).toContain('load blew up');
      await new Promise((r) => setTimeout(r, 20));
      expect(auditSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('audit log failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      auditSpy.mockRestore();
    }
  });
});

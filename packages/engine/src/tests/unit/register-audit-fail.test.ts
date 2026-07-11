/**
 * finalizeExtensionLoad — audit log failure is non-fatal (register.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import * as audit from '../../lib/audit.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(): ExtensionLoader {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    modules: new Map<string, ZveltioExtension>(),
    lastLoadError: new Map(),
    ctx: { db: db.kysely } as unknown as ExtensionContext,
  } as unknown as ExtensionLoader;
}

afterEach(() => {
  process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = undefined;
});

describe('finalizeExtensionLoad — audit resilience', () => {
  it('still marks the extension loaded when the success audit log rejects', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const auditSpy = spyOn(audit, 'auditLog').mockRejectedValue(new Error('audit down'));
    try {
      const loader = fakeLoader();
      const extension: ZveltioExtension = {
        name: 'audit-ext',
        category: 'custom',
        mountStrategy: 'subapp',
        async register(sub) {
          sub.get('/ok', (c) => c.text('ok'));
        },
      };
      await finalizeExtensionLoad(
        loader,
        extension,
        'audit-ext',
        '/tmp/audit-ext',
        new Hono(),
        loader.ctx!,
        { name: 'audit-ext', version: '1.0.0' } as never,
        new Set(),
      );
      expect(loader.loaded.has('audit-ext')).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(auditSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('audit log failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      auditSpy.mockRestore();
    }
  });
});

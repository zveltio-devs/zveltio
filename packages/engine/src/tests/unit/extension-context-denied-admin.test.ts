/**
 * createDeniedAdminDb (lib/extensions/extension-context.ts) — db:admin gate.
 */

import { describe, expect, it } from 'bun:test';
import {
  createDeniedAdminDb,
  ExtensionSecurityError,
} from '../../lib/extensions/extension-context.js';

describe('createDeniedAdminDb', () => {
  it('throws ExtensionSecurityError when a Kysely query method is invoked', () => {
    const admin = createDeniedAdminDb('secret-ext');
    expect(() => admin.selectFrom('zv_users' as never)).toThrow(ExtensionSecurityError);
    try {
      admin.selectFrom('zv_users' as never);
    } catch (err) {
      expect((err as Error).message).toContain('secret-ext');
      expect((err as Error).message).toContain('db:admin');
    }
  });

  it('returns undefined for non-query property access', () => {
    const admin = createDeniedAdminDb('secret-ext');
    expect((admin as { foo?: unknown }).foo).toBeUndefined();
  });
});

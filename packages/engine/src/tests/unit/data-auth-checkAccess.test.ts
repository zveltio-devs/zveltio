/**
 * checkAccess (lib/data/auth.ts) — API-key scope enforcement + session delegation.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/ddl-manager.js';
import { checkAccess } from '../../lib/data/auth.js';
import * as tenancy from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const db = new CannedDb().kysely as unknown as Database;

function apiUser(scopes: unknown, id = 'apikey:key-1') {
  return { id, name: 'test key', role: 'api_key' as const, scopes };
}

afterEach(() => {
  spyOn(tenancy, 'checkPermission').mockRestore();
  spyOn(DDLManager, 'getTableName').mockRestore();
});

describe('checkAccess', () => {
  it('delegates non-api_key users to checkPermission', async () => {
    const spy = spyOn(tenancy, 'checkPermission').mockResolvedValue(true);
    const user = { id: 'u-1', name: 'Alice', role: 'member' };
    await expect(checkAccess(db, user, 'contacts', 'read')).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('u-1', 'contacts', 'read');
  });

  /**
   * This test used to assert the opposite, and asserting it is what kept the
   * defect stable: an empty scope list meant FULL access to every `zvd_*`
   * collection in the tenant, and both the create route and the column default
   * to `[]`. `POST /api/api-keys {"name":"x"}` minted a permanent tenant-wide
   * data credential, while the operator most likely to leave the field blank is
   * the one aiming for least privilege.
   *
   * Migration 045 writes the existing keys' access down explicitly before this
   * meaning flips, so nothing already issued loses anything.
   */
  it('api_key with no scopes is denied — an empty list grants nothing', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await checkAccess(db, apiUser([]), 'articles', 'read')).toBe(false);
      expect(await checkAccess(db, apiUser(undefined), 'articles', 'write')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('api_key with an explicit wildcard still gets full access', async () => {
    const all = [{ collection: '*', actions: ['*'] }];
    expect(await checkAccess(db, apiUser(all), 'articles', 'read')).toBe(true);
    expect(await checkAccess(db, apiUser(all), 'invoices', 'delete')).toBe(true);
  });

  it('api_key enforces per-collection and per-action scopes', async () => {
    const scopes = [{ collection: 'articles', actions: ['read'] }];
    expect(await checkAccess(db, apiUser(scopes), 'articles', 'read')).toBe(true);
    expect(await checkAccess(db, apiUser(scopes), 'articles', 'write')).toBe(false);
    expect(await checkAccess(db, apiUser(scopes), 'invoices', 'read')).toBe(false);
  });

  it('api_key honors wildcard collection and action scopes', async () => {
    const readAll = [{ collection: '*', actions: ['read'] }];
    expect(await checkAccess(db, apiUser(readAll), 'anything', 'read')).toBe(true);
    expect(await checkAccess(db, apiUser(readAll), 'anything', 'delete')).toBe(false);

    const allActions = [{ collection: 'articles', actions: ['*'] }];
    expect(await checkAccess(db, apiUser(allActions), 'articles', 'delete')).toBe(true);
  });

  it('api_key refuses unparseable scopes JSON (fail closed)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await checkAccess(db, apiUser('{not-json'), 'articles', 'read')).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('unparseable scopes'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('api_key refuses non-array scopes', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await checkAccess(db, apiUser({ bad: true }), 'articles', 'read')).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('not an array'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('api_key blocks zv_ system tables that are not zvd_ collections', async () => {
    spyOn(DDLManager, 'getTableName').mockReturnValue('zv_system_meta');
    expect(await checkAccess(db, apiUser([]), 'system_meta', 'read')).toBe(false);
  });
});

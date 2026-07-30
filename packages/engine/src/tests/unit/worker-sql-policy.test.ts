/**
 * Worker→host SQL bridge table policy.
 *
 * `enforcePublisherTier` routes community (untrusted) extensions into a worker
 * because the worker is meant to be the trust boundary. The bridge previously
 * ran their SQL with pool.unsafe() and no restriction at all, so these cases
 * pin the rule that now applies — including the case-folding and
 * schema-qualification tricks that get used to walk past a name check.
 */

import { describe, expect, it } from 'bun:test';
import {
  assertWorkerSqlAllowed,
  ownedPrefixFor,
  WorkerSqlPolicyError,
} from '../../lib/extensions/worker-sql-policy.js';

const EXT = 'ai';

function allowed(sql: string): boolean {
  try {
    assertWorkerSqlAllowed(EXT, sql);
    return true;
  } catch (e) {
    if (e instanceof WorkerSqlPolicyError) return false;
    throw e;
  }
}

describe('ownedPrefixFor', () => {
  it('matches the inline proxy convention', () => {
    expect(ownedPrefixFor('ai')).toBe('zv_ai_');
    expect(ownedPrefixFor('compliance/ro/saft')).toBe('zv_compliance_ro_saft_');
  });
});

describe('assertWorkerSqlAllowed — engine tables', () => {
  const blocked = [
    'SELECT * FROM zv_api_keys',
    'SELECT * FROM zv_tenants',
    'SELECT * FROM zvd_orders JOIN zv_api_keys ON true',
    'UPDATE zv_settings SET value = $1',
    'DELETE FROM zvd_orders WHERE id IN (SELECT id FROM zv_tenant_users)',
    'INSERT INTO zv_scim_tokens (name) VALUES ($1)',
  ];
  for (const sql of blocked) {
    it(`blocks: ${sql.slice(0, 46)}`, () => {
      expect(allowed(sql)).toBe(false);
    });
  }

  it('blocks regardless of case', () => {
    expect(allowed('SELECT * FROM ZV_API_KEYS')).toBe(false);
    expect(allowed('SELECT * FROM Zv_Api_Keys')).toBe(false);
  });

  it('blocks a schema-qualified reference', () => {
    expect(allowed('SELECT * FROM public.zv_api_keys')).toBe(false);
  });

  it('blocks a quoted identifier', () => {
    expect(allowed('SELECT * FROM "zv_api_keys"')).toBe(false);
    expect(allowed('SELECT * FROM public."ZV_API_KEYS"')).toBe(false);
  });

  it('names every offending table in the error', () => {
    try {
      assertWorkerSqlAllowed(EXT, 'SELECT * FROM zv_tenants, zv_api_keys');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('zv_api_keys');
      expect((e as Error).message).toContain('zv_tenants');
    }
  });
});

describe('assertWorkerSqlAllowed — what stays permitted', () => {
  const permitted = [
    'SELECT * FROM zvd_orders',
    'SELECT * FROM zvd_orders WHERE total > $1',
    'INSERT INTO zvd_invoices (id) VALUES ($1)',
    'SELECT * FROM zv_ai_providers',
    'UPDATE zv_ai_chats SET title = $1 WHERE id = $2',
    'SELECT a.* FROM zvd_orders a JOIN zv_ai_providers b ON a.p = b.id',
  ];
  for (const sql of permitted) {
    it(`allows: ${sql.slice(0, 46)}`, () => {
      expect(allowed(sql)).toBe(true);
    });
  }

  it('does not confuse zvd_ with zv_', () => {
    // 'zvd_x' must not be read as an engine table — the third char is 'd'.
    expect(allowed('SELECT * FROM zvd_zv_weird')).toBe(true);
  });
});

describe('assertWorkerSqlAllowed — hiding places', () => {
  it('ignores a table name that only appears inside a string literal', () => {
    expect(allowed("SELECT * FROM zvd_logs WHERE msg = 'read zv_api_keys please'")).toBe(true);
  });

  it('still catches the real reference when a decoy string is present', () => {
    expect(allowed("SELECT * FROM zv_api_keys WHERE note = 'zvd_orders'")).toBe(false);
  });

  it('does not let a line comment conceal a reference', () => {
    // The comment is blanked, so the only live reference is the permitted one.
    expect(allowed('SELECT * FROM zvd_orders -- zv_api_keys')).toBe(true);
    expect(allowed('SELECT * FROM zv_api_keys -- zvd_orders')).toBe(false);
  });

  it('handles block comments and dollar-quoted bodies', () => {
    expect(allowed('SELECT * FROM zvd_orders /* zv_api_keys */')).toBe(true);
    expect(allowed('SELECT $tag$ zv_api_keys $tag$, x FROM zvd_orders')).toBe(true);
  });

  it('handles escaped quotes without losing track of the string', () => {
    expect(allowed("SELECT * FROM zvd_orders WHERE a = 'it''s zv_api_keys'")).toBe(true);
  });
});

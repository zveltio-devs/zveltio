/**
 * DDLManager pure helpers (lib/data/ddl-manager.ts) — table-name derivation +
 * cache invalidation. The DDL-executing methods need Postgres and are covered by
 * the collections integration tests.
 */

import { describe, it, expect } from 'bun:test';
import { DDLManager } from '../../lib/data/ddl-manager.js';

describe('DDLManager.getTableName', () => {
  it('prefixes the collection name with zvd_', () => {
    expect(DDLManager.getTableName('contacts')).toBe('zvd_contacts');
    expect(DDLManager.getTableName('orders_2026')).toBe('zvd_orders_2026');
  });
});

describe('DDLManager.invalidateCache', () => {
  it('is callable with and without a name and never throws', () => {
    expect(() => DDLManager.invalidateCache('contacts')).not.toThrow();
    expect(() => DDLManager.invalidateCache()).not.toThrow();
  });
});

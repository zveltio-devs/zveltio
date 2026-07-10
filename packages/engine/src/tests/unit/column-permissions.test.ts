/**
 * Column-level access filtering (lib/tenancy/column-permissions.ts) — the pure
 * read/write masks applied to every record. Security-relevant: a hidden column
 * must never appear in a response, a read-only column must never be written.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import type Redis from 'ioredis';
import {
  applyColumnAccess,
  filterWritableFields,
  getColumnAccess,
  invalidateColumnPermCache,
} from '../../lib/tenancy/column-permissions.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';
import type { Database } from '../../db/index.js';

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for cache under test
type Args = any[];

class ColPermFakeRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, val: string): Promise<'OK'> {
    this.store.set(key, val);
    return 'OK';
  }
  async del(...keys: Args): Promise<number> {
    for (const k of keys) this.store.delete(String(k));
    return keys.length;
  }
  async scan(cursor: string, _op: string, pattern: string, _countOp: string, _count: number) {
    const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    const matches = [...this.store.keys()].filter((k) => re.test(k));
    return [cursor === '0' && matches.length > 0 ? '0' : '0', matches] as [string, string[]];
  }
}

afterEach(() => {
  _setCacheForTests(null);
});

const access = (hidden: string[], readOnly: string[] = []) => ({
  hidden: new Set(hidden),
  readOnly: new Set(readOnly),
});

describe('applyColumnAccess (read mask)', () => {
  it('returns the record untouched when nothing is hidden', () => {
    const rec = { id: '1', a: 1, b: 2 };
    expect(applyColumnAccess(rec, access([]))).toBe(rec); // same ref, fast path
  });

  it('strips hidden columns', () => {
    const out = applyColumnAccess({ id: '1', ssn: 'x', name: 'y' }, access(['ssn']));
    expect(out).toEqual({ id: '1', name: 'y' });
    expect(out).not.toHaveProperty('ssn');
  });

  it("a '*' hidden mask removes every column", () => {
    const out = applyColumnAccess({ id: '1', a: 2 }, access(['*']));
    expect(out).toEqual({});
  });
});

describe('filterWritableFields (write mask)', () => {
  it('passes everything through when nothing is read-only', () => {
    const data = { a: 1, b: 2 };
    const r = filterWritableFields(data, access([], []));
    expect(r.data).toBe(data);
    expect(r.blocked).toEqual([]);
  });

  it('drops read-only fields and reports them as blocked', () => {
    const r = filterWritableFields({ a: 1, locked: 2, c: 3 }, access([], ['locked']));
    expect(r.data).toEqual({ a: 1, c: 3 });
    expect(r.blocked).toEqual(['locked']);
  });

  it("a '*' read-only mask blocks every field", () => {
    const r = filterWritableFields({ a: 1, b: 2 }, access([], ['*']));
    expect(r.data).toEqual({});
    expect(r.blocked.sort()).toEqual(['a', 'b']);
  });
});

describe('getColumnAccess', () => {
  it('short-circuits full access for admin roles', async () => {
    const db = new CannedDb();
    const access = await getColumnAccess(db.kysely as unknown as Database, 'contacts', 'admin');
    expect(access.hidden.size).toBe(0);
    expect(access.readOnly.size).toBe(0);
    expect(db.log.length).toBe(0);
  });

  it('loads masks from zvd_column_permissions and caches them in Valkey', async () => {
    const db = new CannedDb();
    db.when(/FROM "zvd_column_permissions"/i, [
      { column_name: 'ssn', can_read: false, can_write: false },
      { column_name: 'salary', can_read: true, can_write: false },
    ]);
    const redis = new ColPermFakeRedis();
    _setCacheForTests(redis as unknown as Redis);

    const first = await getColumnAccess(db.kysely as unknown as Database, 'payroll', 'viewer');
    expect(first.hidden.has('ssn')).toBe(true);
    expect(first.readOnly.has('salary')).toBe(true);
    expect(redis.store.has('colperms:payroll:viewer')).toBe(true);

    db.when(/FROM "zvd_column_permissions"/i, () => {
      throw new Error('should not hit DB on cache hit');
    });
    const second = await getColumnAccess(db.kysely as unknown as Database, 'payroll', 'viewer');
    expect(second.hidden.has('ssn')).toBe(true);
  });
});

describe('invalidateColumnPermCache', () => {
  it('scans and deletes colperms keys for a collection', async () => {
    const redis = new ColPermFakeRedis();
    redis.store.set('colperms:contacts:editor', '{}');
    redis.store.set('colperms:contacts:viewer', '{}');
    redis.store.set('colperms:orders:editor', '{}');
    _setCacheForTests(redis as unknown as Redis);

    await invalidateColumnPermCache('contacts');
    expect(redis.store.has('colperms:contacts:editor')).toBe(false);
    expect(redis.store.has('colperms:contacts:viewer')).toBe(false);
    expect(redis.store.has('colperms:orders:editor')).toBe(true);
  });
});

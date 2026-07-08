/**
 * Column-level access filtering (lib/tenancy/column-permissions.ts) — the pure
 * read/write masks applied to every record. Security-relevant: a hidden column
 * must never appear in a response, a read-only column must never be written.
 */

import { describe, it, expect } from 'bun:test';
import { applyColumnAccess, filterWritableFields } from '../../lib/tenancy/column-permissions.js';

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

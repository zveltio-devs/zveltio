/**
 * More pure query-parse helpers (lib/data/query-parse.ts): buildAllowedCols +
 * decodeCursor, example-based (complements the fuzz suite).
 */

import { describe, it, expect } from 'bun:test';
import { buildAllowedCols, decodeCursor } from '../../lib/data/query-parse.js';
// biome-ignore lint/suspicious/noExplicitAny: dynamic collection shape in tests
type Any = any;

describe('buildAllowedCols', () => {
  it('includes the collection field names', () => {
    const cols = buildAllowedCols({ fields: [{ name: 'title' }, { name: 'qty' }] } as Any);
    expect(cols.has('title')).toBe(true);
    expect(cols.has('qty')).toBe(true);
  });

  it('a null collection yields only the system columns (no user fields)', () => {
    const cols = buildAllowedCols(null);
    expect(cols.has('some_user_field')).toBe(false);
    expect(cols.size).toBeGreaterThan(0); // system columns are always allowed
  });

  it('drops fields without a name', () => {
    const cols = buildAllowedCols({ fields: [{ name: '' }, { name: 'ok' }] } as Any);
    expect(cols.has('')).toBe(false);
    expect(cols.has('ok')).toBe(true);
  });
});

describe('decodeCursor', () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('returns null for an undefined or malformed cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!not-base64-json')).toBeNull();
  });

  it('decodes a well-formed { id, val } cursor', () => {
    expect(decodeCursor(encode({ id: 'abc', val: 5 }))).toEqual({ id: 'abc', val: 5 });
  });

  it('returns null when id is empty or val is missing', () => {
    expect(decodeCursor(encode({ id: '', val: 5 }))).toBeNull();
    expect(decodeCursor(encode({ id: 'abc' }))).toBeNull();
  });
});

/**
 * More pure query-parse helpers (lib/data/query-parse.ts): buildAllowedCols +
 * openCursor, example-based (complements the fuzz suite).
 */

import { describe, it, expect } from 'bun:test';
import {
  buildAllowedCols,
  openCursor,
  sealCursor,
  START_CURSOR,
} from '../../lib/data/query-parse.js';

process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-long';
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

describe('openCursor', () => {
  const bind = { collection: 'zvd_t', sort: 'created_at', desc: true };
  const plain = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('returns null for an undefined or malformed cursor', () => {
    expect(openCursor(undefined, bind)).toBeNull();
    expect(openCursor('!!!not-base64-json', bind)).toBeNull();
  });

  it('opens a sealed { id, val } and the start cursor', () => {
    expect(openCursor(sealCursor({ id: 'abc', val: 5 }, bind), bind)).toEqual({
      id: 'abc',
      val: 5,
    });
    expect(openCursor(START_CURSOR, bind)).toBe('start');
  });

  it('refuses a cursor the client wrote, or one tampered with', () => {
    expect(openCursor(plain({ id: 'abc', val: 5 }), bind)).toBeNull();
    const sealed = Buffer.from(sealCursor({ id: 'abc', val: 5 }, bind), 'base64url');
    sealed[sealed.length - 1] ^= 1;
    expect(openCursor(sealed.toString('base64url'), bind)).toBeNull();
  });

  it('refuses a cursor sealed under a secret the process no longer holds', () => {
    const before = process.env.BETTER_AUTH_SECRET;
    const c = sealCursor({ id: 'abc', val: 5 }, bind);
    process.env.BETTER_AUTH_SECRET = 'rotated-secret-minimum-32-characters-long!!';
    try {
      expect(openCursor(c, bind)).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = before;
    }
    expect(openCursor(c, bind)).toEqual({ id: 'abc', val: 5 });
  });

  it('does not show the position it carries', () => {
    const c = sealCursor({ id: 'row-7', val: '2026-01-01T00:00:00Z' }, bind);
    expect(Buffer.from(c, 'base64url').toString('latin1')).not.toContain('row-7');
  });
});

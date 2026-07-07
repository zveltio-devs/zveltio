import { describe, expect, test } from 'bun:test';
import { resolveConversion } from '../../lib/data/field-type-conversions.js';

// Pure strategy table: given (from, to, targetSqlType, columnName), decide
// whether an ALTER COLUMN ... TYPE is allowed and what USING clause to emit.
// These assertions pin the exact SQL the DDL layer will run against Postgres.
describe('resolveConversion', () => {
  test('rejects a no-op conversion (identical types)', () => {
    const r = resolveConversion('text', 'text', 'TEXT', 'title');
    expect(r).toEqual({ ok: false, reason: 'New type is identical to current type' });
  });

  test('rejects conversions that touch a relation type', () => {
    for (const [from, to] of [
      ['m2o', 'text'],
      ['text', 'o2m'],
      ['m2m', 'integer'],
      ['reference', 'text'],
    ] as const) {
      const r = resolveConversion(from, to, 'TEXT', 'owner');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/relation types/i);
    }
  });

  test('text-family → text-family needs no USING clause', () => {
    const r = resolveConversion('text', 'email', 'TEXT', 'contact');
    expect(r).toEqual({ ok: true, sqlType: 'TEXT' });
  });

  test('number-family widening uses an explicit cast', () => {
    const r = resolveConversion('integer', 'bigint', 'BIGINT', 'qty');
    expect(r).toEqual({ ok: true, sqlType: 'BIGINT', using: '"qty"::BIGINT' });
  });

  test('text → number maps blank strings to NULL before casting', () => {
    const r = resolveConversion('text', 'integer', 'INTEGER', 'amount');
    expect(r).toEqual({ ok: true, sqlType: 'INTEGER', using: `NULLIF("amount", '')::INTEGER` });
  });

  test('number → text casts to TEXT', () => {
    const r = resolveConversion('decimal', 'text', 'TEXT', 'price');
    expect(r).toEqual({ ok: true, sqlType: 'TEXT', using: '"price"::TEXT' });
  });

  test('text ↔ boolean', () => {
    expect(resolveConversion('text', 'boolean', 'BOOLEAN', 'flag')).toEqual({
      ok: true,
      sqlType: 'BOOLEAN',
      using: `NULLIF("flag", '')::BOOLEAN`,
    });
    expect(resolveConversion('boolean', 'text', 'TEXT', 'flag')).toEqual({
      ok: true,
      sqlType: 'TEXT',
      using: '"flag"::TEXT',
    });
  });

  test('date ↔ datetime cast between DATE and TIMESTAMP', () => {
    expect(resolveConversion('date', 'datetime', 'TIMESTAMP', 'due')).toEqual({
      ok: true,
      sqlType: 'TIMESTAMP',
      using: '"due"::TIMESTAMP',
    });
    expect(resolveConversion('datetime', 'date', 'DATE', 'due')).toEqual({
      ok: true,
      sqlType: 'DATE',
      using: '"due"::DATE',
    });
  });

  test('text ↔ json cast through JSONB', () => {
    expect(resolveConversion('text', 'jsonb', 'JSONB', 'meta')).toEqual({
      ok: true,
      sqlType: 'JSONB',
      using: '"meta"::JSONB',
    });
    expect(resolveConversion('json', 'text', 'TEXT', 'meta')).toEqual({
      ok: true,
      sqlType: 'TEXT',
      using: '"meta"::TEXT',
    });
  });

  test('unenumerated pair falls back to a direct cast', () => {
    const r = resolveConversion('boolean', 'integer', 'INTEGER', 'active');
    expect(r).toEqual({ ok: true, sqlType: 'INTEGER', using: '"active"::INTEGER' });
  });

  test('column identifier is always double-quoted in the USING clause', () => {
    const r = resolveConversion('integer', 'text', 'TEXT', 'select');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.using).toContain('"select"');
  });
});

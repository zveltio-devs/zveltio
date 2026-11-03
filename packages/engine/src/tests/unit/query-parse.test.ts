/**
 * parseFilters — example-based cases, incl. the regression the fuzz suite kept
 * finding: an EMPTY operator object/array as a filter value must be ignored, not
 * throw (it used to `Object.entries(value)[0]` → TypeError → a 500).
 */

import { describe, it, expect } from 'bun:test';
import { parseFilters } from '../../lib/data/query-parse.js';

const cols = new Set(['a', 'b']);

describe('parseFilters — empty operator regression', () => {
  it('an empty-object filter value is ignored, never throws', () => {
    const r = parseFilters({}, '{"a": {}}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toEqual({});
  });

  it('an empty-array filter value is a typed error, never throws', () => {
    const r = parseFilters({}, '{"a": []}', cols);
    expect(r.ok).toBe(false);
  });
});

describe('parseFilters — JSON format', () => {
  it('a scalar value becomes an eq filter', () => {
    const r = parseFilters({}, '{"a": "x"}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters.a).toEqual({ op: 'eq', value: 'x' });
  });

  it('an operator object maps to a canonical op + value', () => {
    const r = parseFilters({}, '{"a": {"gt": 5}}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([r.filters.a].flat()[0]?.value).toBe(5);
      expect(typeof [r.filters.a].flat()[0]?.op).toBe('string');
    }
  });

  it('an unknown filter field is a typed error', () => {
    const r = parseFilters({}, '{"z": 1}', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Unknown filter field');
  });

  // ADR 0019 decision 6: a filter that cannot be applied is refused, never
  // skipped — a skipped filter answered with every readable row.
  it('malformed or non-object JSON is a typed error', () => {
    for (const f of ['{not json', '5', 'null', '[1]']) {
      const r = parseFilters({}, f, cols);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Malformed filter');
    }
  });

  it('an unknown operator key is a typed error', () => {
    const r = parseFilters({}, '{"a": {"intersects": 1}}', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Unknown filter operator: 'intersects' on 'a'");
  });

  it('a list value is a typed error, not an operator map', () => {
    const r = parseFilters({}, '{"a": [1, 2]}', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"in"');
  });
});

describe('parseFilters — bracket format', () => {
  it('parses field[op]=value and coerces numeric comparison values', () => {
    const r = parseFilters({ 'a[gt]': '5' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.filters.a].flat()[0]?.value).toBe(5);
  });

  it('an unknown bracket field is a typed error', () => {
    const r = parseFilters({ 'zzz[gt]': '5' }, undefined, cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Unknown filter field: 'zzz'");
  });

  it('an unknown bracket operator is a typed error', () => {
    for (const op of ['foo', 'constructor']) {
      const r = parseFilters({ [`a[${op}]`]: '1' }, undefined, cols);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(`Unknown filter operator: '${op}' on 'a'`);
    }
  });

  it('a bracket key it cannot parse is a typed error, not skipped', () => {
    for (const key of ['my-field[near]', 'a[gt][x]', '1a[eq]', 'a[]']) {
      const r = parseFilters({ [key]: '1' }, undefined, cols);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(`Malformed filter key: '${key}'`);
    }
    expect(parseFilters({ limit: '5' }, undefined, cols).ok).toBe(true);
  });

  it('JSON overrides bracket for the same field', () => {
    const r = parseFilters({ 'a[gt]': '5' }, '{"a": "json"}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters.a).toEqual({ op: 'eq', value: 'json' });
  });
});

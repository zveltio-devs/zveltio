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

  it('an empty-array filter value is ignored, never throws', () => {
    const r = parseFilters({}, '{"a": []}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toEqual({});
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
      expect(r.filters.a?.value).toBe(5);
      expect(typeof r.filters.a?.op).toBe('string');
    }
  });

  it('an unknown filter field is a typed error', () => {
    const r = parseFilters({}, '{"z": 1}', cols);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Unknown filter field');
  });

  it('malformed JSON is ignored (no filters, no throw)', () => {
    const r = parseFilters({}, '{not json', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toEqual({});
  });

  it('an unknown operator key is skipped', () => {
    const r = parseFilters({}, '{"a": {"bogus": 1}}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toEqual({});
  });
});

describe('parseFilters — bracket format', () => {
  it('parses field[op]=value and coerces numeric comparison values', () => {
    const r = parseFilters({ 'a[gt]': '5' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters.a?.value).toBe(5);
  });

  it('silently skips an unknown bracket field', () => {
    const r = parseFilters({ 'zzz[gt]': '5' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toEqual({});
  });

  it('JSON overrides bracket for the same field', () => {
    const r = parseFilters({ 'a[gt]': '5' }, '{"a": "json"}', cols);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters.a).toEqual({ op: 'eq', value: 'json' });
  });
});

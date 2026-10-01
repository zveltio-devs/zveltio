/**
 * parseFilters — in operator via JSON filter (lib/data/query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { parseFilters } from '../../lib/data/query-parse.js';

const cols = new Set(['label', 'score']);

describe('parseFilters — in via JSON', () => {
  it('parses in arrays from JSON filter syntax', () => {
    const r = parseFilters({}, JSON.stringify({ label: { in: ['a', 'b'] } }), cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.label).toEqual({ op: 'in', value: ['a', 'b'] });
    }
  });

  it('parses not_in arrays from JSON filter syntax', () => {
    const r = parseFilters({}, JSON.stringify({ score: { not_in: [1, 2] } }), cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.score?.op).toBe('not_in');
      expect(r.filters.score?.value).toEqual([1, 2]);
    }
  });
});

describe('parseFilters — in via brackets', () => {
  it('reads a comma-separated list, because a query string has no arrays', () => {
    const r = parseFilters({ 'label[in]': 'a,b', 'score[not_in]': '1' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.label).toEqual({ op: 'in', value: ['a', 'b'] });
      expect(r.filters.score).toEqual({ op: 'not_in', value: ['1'] });
    }
  });
});

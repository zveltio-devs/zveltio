/**
 * parseFilters — lt / lte bracket operators (lib/data/query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { parseFilters } from '../../lib/data/query-parse.js';

const cols = new Set(['score', 'label']);

describe('parseFilters — lt and lte', () => {
  it('parses lt from bracket query params', () => {
    const r = parseFilters({ 'score[lt]': '40' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.score).toEqual({ op: 'lt', value: 40 });
    }
  });

  it('parses lte from bracket query params', () => {
    const r = parseFilters({ 'score[lte]': '40' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.score).toEqual({ op: 'lte', value: 40 });
    }
  });
});

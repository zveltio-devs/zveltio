/**
 * parseFilters — bracket lt operator (query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { buildAllowedCols, parseFilters } from '../../lib/data/query-parse.js';

const cols = buildAllowedCols({
  fields: [{ name: 'score', type: 'number' }],
} as never);

describe('parseFilters — bracket lt', () => {
  it('coerces numeric bracket values for lt comparisons', () => {
    const r = parseFilters({ 'score[lt]': '10' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.score).toEqual({ op: 'lt', value: 10 });
  });
});

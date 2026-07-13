/**
 * parseFilters — bracket gt operator (query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { buildAllowedCols, parseFilters } from '../../lib/data/query-parse.js';

const cols = buildAllowedCols({
  fields: [{ name: 'score', type: 'number' }],
} as never);

describe('parseFilters — bracket gt', () => {
  it('coerces numeric bracket values for gt comparisons', () => {
    const r = parseFilters({ 'score[gt]': '25' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.score).toEqual({ op: 'gt', value: 25 });
  });
});

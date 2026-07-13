/**
 * parseFilters — bracket syntax for is_null / is_not_null (query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { buildAllowedCols, parseFilters } from '../../lib/data/query-parse.js';

const cols = buildAllowedCols({
  fields: [
    { name: 'note', type: 'text' },
    { name: 'code', type: 'text' },
  ],
} as never);

describe('parseFilters — bracket null operators', () => {
  it('maps note[is_null] to a null filter condition', () => {
    const r = parseFilters({ 'note[is_null]': 'true' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.note).toEqual({ op: 'null', value: 'true' });
  });

  it('maps code[is_not_null] to a not_null filter condition', () => {
    const r = parseFilters({ 'code[is_not_null]': '1' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.code).toEqual({ op: 'not_null', value: '1' });
  });

  it('silently skips unknown fields in bracket syntax', () => {
    const r = parseFilters({ 'ghost[is_null]': 'true' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters).toEqual({});
  });
});

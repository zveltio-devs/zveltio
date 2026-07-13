/**
 * parseFilters — bracket neq operator (query-parse.ts).
 */

import { describe, expect, it } from 'bun:test';
import { buildAllowedCols, parseFilters } from '../../lib/data/query-parse.js';

const cols = buildAllowedCols({
  fields: [{ name: 'tier', type: 'text' }],
} as never);

describe('parseFilters — bracket neq', () => {
  it('maps tier[neq] to a neq filter condition', () => {
    const r = parseFilters({ 'tier[neq]': 'bronze' }, undefined, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.tier).toEqual({ op: 'neq', value: 'bronze' });
  });

  it('lets JSON filter override the same field from bracket syntax', () => {
    const json = JSON.stringify({ tier: { eq: 'gold' } });
    const r = parseFilters({ 'tier[neq]': 'bronze' }, json, cols);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.tier).toEqual({ op: 'eq', value: 'gold' });
  });
});

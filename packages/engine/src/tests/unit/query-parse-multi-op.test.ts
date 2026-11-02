import { describe, expect, test } from 'bun:test';
import { parseFilters } from '../../lib/data/query-parse.js';

// Several operators on one field are ANDed. The parser once kept only the
// first, so `{"price":{"gt":1,"lt":9}}` returned every row above 1 with a 200.
describe('parseFilters — several operators on one field', () => {
  const cols = new Set(['price']);

  test('JSON keeps every operator', () => {
    const r = parseFilters({}, '{"price":{"gt":1,"lt":9}}', cols);
    expect(r).toEqual({
      ok: true,
      filters: {
        price: [
          { op: 'gt', value: 1 },
          { op: 'lt', value: 9 },
        ],
      },
    });
  });

  test('bracket keeps every operator', () => {
    const r = parseFilters({ 'price[gte]': '1', 'price[lte]': '9' }, undefined, cols);
    expect(r).toEqual({
      ok: true,
      filters: {
        price: [
          { op: 'gte', value: 1 },
          { op: 'lte', value: 9 },
        ],
      },
    });
  });

  test('JSON replaces the bracket set; an empty operator object leaves it', () => {
    const q = { 'price[gte]': '1', 'price[lte]': '9' };
    expect(parseFilters(q, '{"price":{"eq":5}}', cols)).toEqual({
      ok: true,
      filters: { price: { op: 'eq', value: 5 } },
    });
    const kept = parseFilters(q, '{"price":{}}', cols);
    expect(kept.ok && Array.isArray(kept.filters.price)).toBe(true);
  });
});

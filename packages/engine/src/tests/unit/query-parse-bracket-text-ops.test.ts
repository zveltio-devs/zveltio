/**
 * parseFilters — the business text operators (query-parse.ts). Text field types
 * advertised not_contains / starts_with / ends_with while the parser skipped
 * them, so `name[starts_with]=A` answered every row.
 */

import { describe, expect, it } from 'bun:test';
import { buildAllowedCols, parseFilters } from '../../lib/data/query-parse.js';

const cols = buildAllowedCols({ fields: [{ name: 'name', type: 'text' }] } as never);

describe('parseFilters — text operators', () => {
  for (const op of ['not_contains', 'starts_with', 'ends_with'] as const) {
    it(`maps name[${op}] in the bracket form and the JSON form`, () => {
      const bracket = parseFilters({ [`name[${op}]`]: 'Ab' }, undefined, cols);
      expect(bracket).toMatchObject({ ok: true, filters: { name: { op, value: 'Ab' } } });
      const json = parseFilters({}, JSON.stringify({ name: { [op]: 'Ab' } }), cols);
      expect(json).toMatchObject({ ok: true, filters: { name: { op, value: 'Ab' } } });
    });
  }

  it('keeps contains, like and ilike as one operator', () => {
    for (const op of ['contains', 'like', 'ilike']) {
      const r = parseFilters({ [`name[${op}]`]: 'x' }, undefined, cols);
      expect(r).toMatchObject({ ok: true, filters: { name: { op: 'ilike' } } });
    }
  });
});

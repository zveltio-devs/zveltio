/**
 * ADR 0019 decision 6: a core field type advertises in `filterOperators`
 * (`GET /field-types`) only operators the data API's filter parser accepts.
 * `location`/`geometry` advertised `near`/`within`/`intersects` while
 * `parseFilters` dropped them and the list answered every row.
 */

import { expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { FieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import { parseFilters } from '../../lib/data/query-parse.js';

it('every advertised operator of a core field type parses', () => {
  const registry = new FieldTypeRegistry();
  registerCoreFieldTypes(registry);
  const refused: string[] = [];
  for (const t of registry.getAll()) {
    for (const op of t.api.filterOperators ?? []) {
      if (!parseFilters({ [`f[${op}]`]: 'x' }, undefined, new Set(['f'])).ok) {
        refused.push(`${t.type}:${op}`);
      }
    }
  }
  expect(refused).toEqual([]);
});

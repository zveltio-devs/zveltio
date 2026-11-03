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
      const value = op === 'near' ? '44.4,26.1,500' : op === 'within' ? '44,26,45,27' : 'x';
      const geo = new Set(t.type === 'location' ? ['f'] : []);
      if (!parseFilters({ [`f[${op}]`]: value }, undefined, new Set(['f']), geo).ok) {
        refused.push(`${t.type}:${op}`);
      }
    }
  }
  expect(refused).toEqual([]);
});

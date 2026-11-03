/**
 * ADR 0019 tier 1: `near` and `within` on a `location` field, both forms.
 * Only a `location` field takes them, a `location` field takes nothing else
 * but the null checks, and a value the compiler cannot read is a 400.
 */

import { describe, expect, it } from 'bun:test';
import { parseFilters } from '../../lib/data/query-parse.js';

const cols = new Set(['loc', 'name']);
const geo = new Set(['loc']);
const parse = (q: Record<string, string>, json?: string) => parseFilters(q, json, cols, geo);

describe('geo filters', () => {
  it('reads near and within from the bracket form', () => {
    expect(parse({ 'loc[near]': '44.4,26.1,500' })).toEqual({
      ok: true,
      filters: { loc: { op: 'near', value: { lat: 44.4, lng: 26.1, radius: 500 } } },
    });
    expect(parse({ 'loc[within]': '44,26,45,27' })).toEqual({
      ok: true,
      filters: {
        loc: { op: 'within', value: { minLat: 44, minLng: 26, maxLat: 45, maxLng: 27 } },
      },
    });
  });

  it('reads them from the JSON form', () => {
    const r = parse({}, JSON.stringify({ loc: { near: { lat: 1, lng: 2, radius: 3 } } }));
    expect(r).toEqual({
      ok: true,
      filters: { loc: { op: 'near', value: { lat: 1, lng: 2, radius: 3 } } },
    });
  });

  it.each([
    ['loc[near]', '44.4,26.1'],
    ['loc[near]', '44.4,26.1,0'],
    ['loc[near]', '91,26.1,5'],
    ['loc[near]', '44,181,5'],
    ['loc[near]', 'a,b,c'],
    ['loc[near]', '44,,5'],
    ['loc[within]', '44,27,45,26'],
    ['loc[within]', '45,26,44,27'],
    ['loc[within]', '44,26,45'],
  ])('refuses %s=%s', (k, v) => {
    expect(parse({ [k]: v }).ok).toBe(false);
  });

  it('refuses a geo operator off a location field and others on one', () => {
    expect(parse({ 'name[near]': '1,2,3' }).ok).toBe(false);
    expect(parse({ 'loc[eq]': 'x' }).ok).toBe(false);
    expect(parse({}, JSON.stringify({ loc: 'x' })).ok).toBe(false);
    expect(parse({ 'loc[is_null]': 'true' }).ok).toBe(true);
  });

  it('refuses near without the location columns (virtual collections)', () => {
    expect(parseFilters({ 'loc[near]': '1,2,3' }, undefined, cols).ok).toBe(false);
  });
});

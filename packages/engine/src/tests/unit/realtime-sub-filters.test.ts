/**
 * parseSubFilters (routes/realtime.ts): a stream filter the matcher cannot
 * evaluate is refused (ADR 0019 decision 6). Malformed JSON used to mean "no
 * filter" — every event delivered — and `{"price":{"gt":50}}` became `eq` 50.
 */

import { expect, it } from 'bun:test';
import { parseSubFilters } from '../../routes/realtime.js';

it('keeps every eq/neq/in operator on a field', () => {
  expect(parseSubFilters('{"s":"a","p":{"neq":1,"in":[2,3]}}')).toEqual({
    ok: true,
    filters: [
      { field: 's', op: 'eq', value: 'a' },
      { field: 'p', op: 'neq', value: 1 },
      { field: 'p', op: 'in', value: [2, 3] },
    ],
  });
  expect(parseSubFilters(undefined)).toEqual({ ok: true, filters: [] });
});

it('refuses what the stream cannot evaluate', () => {
  for (const raw of ['{not json', '5', 'null', '[1]', '{"p":{"gt":50}}', '{"p":[1]}']) {
    expect(parseSubFilters(raw).ok).toBe(false);
  }
});

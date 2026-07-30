/**
 * RLS conditions on write paths.
 *
 * The policies configured under `/api/admin/rls` were applied when *reading*
 * rows and nowhere else, so a rule like "a member sees only their own records"
 * held for GET and evaporated for PATCH/PUT/DELETE and the bulk and sync push
 * endpoints — knowing a UUID was enough to modify or delete someone else's row.
 *
 * `applyRlsFilters` is the shared piece those paths now run, so these tests pin
 * its behaviour against a query-builder stub that records what it was asked to
 * constrain.
 */

import { describe, expect, it } from 'bun:test';
import { applyRlsFilters } from '../../lib/tenancy/rls.js';

type Recorded = { field: string; op: string; value: unknown };

/** Chainable stand-in for the dynamic Kysely builder used over runtime tables. */
function makeQuery() {
  const calls: Recorded[] = [];
  const q = {
    calls,
    where(field: string, op: string, value: unknown) {
      calls.push({ field, op, value });
      return q;
    },
  };
  return q;
}

describe('applyRlsFilters', () => {
  it('returns the query untouched when no policy matches', () => {
    const q = makeQuery();
    const out = applyRlsFilters(q, []);
    expect(out).toBe(q);
    expect(q.calls).toHaveLength(0);
  });

  it('translates an eq policy into an equality constraint', () => {
    const q = makeQuery();
    applyRlsFilters(q, [{ field: 'owner_id', condition: { op: 'eq', value: 'user-1' } }]);
    expect(q.calls).toEqual([{ field: 'owner_id', op: '=', value: 'user-1' }]);
  });

  it('translates a neq policy into an inequality constraint', () => {
    const q = makeQuery();
    applyRlsFilters(q, [{ field: 'status', condition: { op: 'neq', value: 'archived' } }]);
    expect(q.calls).toEqual([{ field: 'status', op: '!=', value: 'archived' }]);
  });

  it('ANDs every matching policy — most restrictive wins', () => {
    const q = makeQuery();
    applyRlsFilters(q, [
      { field: 'owner_id', condition: { op: 'eq', value: 'user-1' } },
      { field: 'tenant', condition: { op: 'eq', value: 't-1' } },
      { field: 'status', condition: { op: 'neq', value: 'deleted' } },
    ]);
    expect(q.calls).toHaveLength(3);
    expect(q.calls.map((c) => c.field)).toEqual(['owner_id', 'tenant', 'status']);
  });

  it('ignores operators it cannot express, rather than dropping the query', () => {
    // An unsupported op must not silently widen access by throwing the whole
    // filter set away — the other conditions still have to be applied.
    const q = makeQuery();
    applyRlsFilters(q, [
      // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising an unmapped op
      { field: 'weird', condition: { op: 'contains' as any, value: 'x' } },
      { field: 'owner_id', condition: { op: 'eq', value: 'user-1' } },
    ]);
    expect(q.calls).toEqual([{ field: 'owner_id', op: '=', value: 'user-1' }]);
  });

  it('preserves the value type it was given', () => {
    const q = makeQuery();
    applyRlsFilters(q, [
      { field: 'n', condition: { op: 'eq', value: 42 } },
      { field: 'b', condition: { op: 'eq', value: false } },
      { field: 'nil', condition: { op: 'eq', value: null } },
    ]);
    expect(q.calls.map((c) => c.value)).toEqual([42, false, null]);
  });

  it('is chainable so callers can keep building', () => {
    const q = makeQuery();
    const out = applyRlsFilters(q, [{ field: 'owner_id', condition: { op: 'eq', value: 'u' } }]);
    out.where('id', '=', 'rec-1');
    expect(q.calls).toHaveLength(2);
  });
});

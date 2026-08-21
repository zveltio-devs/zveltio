/**
 * Listing a collection enforces entity access, the same as reading one record.
 *
 * `GET /:collection/:id` has run `entityAccessRegistry.isAllowed(...)` for a
 * long time and answers 404 when a rule denies the record. `GET /:collection`
 * ran no such check at all — so an extension registering "agents see only their
 * own tickets" had it enforced on exactly one of the two ways to read the data,
 * and the wide door was the unguarded one. `single.ts` held six references to
 * the registry; `list.ts` held zero.
 *
 * The registry is a JS callback over the whole record, so there is no WHERE to
 * push the rule into and the filter has to happen after the query. These tests
 * pin what matters: denied rows do not come back, allowed rows still do, and a
 * table nobody registered a rule for is untouched.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';

const TABLE = 'zvd_tickets_entity_access_test';

interface Ticket {
  id: string;
  owner: string;
}

beforeEach(() => {
  entityAccessRegistry.clear();
});

describe('entityAccessRegistry — the primitive the list handler now uses', () => {
  it('reports no checks for a table nobody registered', () => {
    // The fast path. Without it the list handler awaits once per row on every
    // collection in the product to reach the same "allow" every time.
    expect(entityAccessRegistry.hasChecksFor(TABLE)).toBe(false);
  });

  it('reports checks once one is registered, and only for that table', () => {
    entityAccessRegistry.registerAs('test', TABLE, () => 'allow');
    expect(entityAccessRegistry.hasChecksFor(TABLE)).toBe(true);
    expect(entityAccessRegistry.hasChecksFor('zvd_something_else')).toBe(false);
  });

  it('filters a result set the way the list handler does', async () => {
    entityAccessRegistry.registerAs('test', TABLE, (record, user) =>
      (record as Ticket).owner === (user as { id: string }).id ? 'allow' : 'deny',
    );

    const rows: Ticket[] = [
      { id: 'a', owner: 'u1' },
      { id: 'b', owner: 'u2' },
      { id: 'c', owner: 'u1' },
    ];
    const decisions = await Promise.all(
      rows.map((r) => entityAccessRegistry.isAllowed(TABLE, r, { id: 'u1' }, 'view')),
    );
    const visible = rows.filter((_, i) => decisions[i] === true);

    expect(visible.map((r) => r.id)).toEqual(['a', 'c']);
    // The one that matters: somebody else's row is gone, not merely blanked.
    expect(visible.some((r) => r.owner === 'u2')).toBe(false);
  });

  it('a deny on one row does not hide the others', async () => {
    // A check that threw, or denied everything, would satisfy "the denied row is
    // absent" while breaking the feature entirely.
    entityAccessRegistry.registerAs('test', TABLE, (record) =>
      (record as Ticket).id === 'b' ? 'deny' : 'allow',
    );
    const rows: Ticket[] = [
      { id: 'a', owner: 'u1' },
      { id: 'b', owner: 'u1' },
      { id: 'c', owner: 'u1' },
    ];
    const decisions = await Promise.all(
      rows.map((r) => entityAccessRegistry.isAllowed(TABLE, r, { id: 'u1' }, 'view')),
    );
    expect(rows.filter((_, i) => decisions[i]).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('checks are scoped per table — a rule on one does not filter another', async () => {
    entityAccessRegistry.registerAs('test', TABLE, () => 'deny');
    expect(
      await entityAccessRegistry.isAllowed('zvd_other', { id: 'x' }, { id: 'u1' }, 'view'),
    ).toBe(true);
  });
});

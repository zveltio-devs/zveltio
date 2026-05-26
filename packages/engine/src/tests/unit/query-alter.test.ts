import { describe, it, expect, beforeEach } from 'bun:test';
import { QueryAlterRegistryImpl } from '../../lib/query-alter.js';

// Fake query builder for testing — the real one is Kysely, but the registry
// itself doesn't care about the shape: it just chains the user-provided alters.
// We use a builder whose .where() records calls so assertions are easy.
class FakeQB {
  whereCalls: Array<{ field: string; op: string; value: unknown }> = [];
  where(field: string, op: string, value: unknown): FakeQB {
    const cloned = new FakeQB();
    cloned.whereCalls = [...this.whereCalls, { field, op, value }];
    return cloned;
  }
}

describe('QueryAlterRegistryImpl', () => {
  let registry: QueryAlterRegistryImpl;

  beforeEach(() => {
    registry = new QueryAlterRegistryImpl();
  });

  it('returns qb unchanged when no alters are registered', () => {
    const qb = new FakeQB();
    const result = registry.applyAll(qb, 'zvd_contacts', { id: 'u1' });
    expect(result).toBe(qb);
    expect((result as FakeQB).whereCalls).toEqual([]);
  });

  it('applies a single alter for the matching table', () => {
    registry.registerAs('crm', 'zvd_contacts', (qb: FakeQB, user: any) =>
      qb.where('tenant_id', '=', user.tenantId),
    );
    const qb = new FakeQB();
    const result = registry.applyAll(qb, 'zvd_contacts', { tenantId: 't1' }) as FakeQB;
    expect(result.whereCalls).toEqual([{ field: 'tenant_id', op: '=', value: 't1' }]);
  });

  it('does NOT apply alters from other tables', () => {
    registry.registerAs('crm', 'zvd_invoices', (qb: FakeQB) => qb.where('paid', '=', true));
    const qb = new FakeQB();
    const result = registry.applyAll(qb, 'zvd_contacts', { id: 'u1' }) as FakeQB;
    expect(result.whereCalls).toEqual([]);
  });

  it('chains multiple alters in registration order', () => {
    registry.registerAs('a', 'zvd_x', (qb: FakeQB) => qb.where('a', '=', 1));
    registry.registerAs('b', 'zvd_x', (qb: FakeQB) => qb.where('b', '=', 2));
    const result = registry.applyAll(new FakeQB(), 'zvd_x', {}) as FakeQB;
    expect(result.whereCalls).toEqual([
      { field: 'a', op: '=', value: 1 },
      { field: 'b', op: '=', value: 2 },
    ]);
  });

  it('unregisterAll(owner) removes only that extension’s alters', () => {
    registry.registerAs('a', 'zvd_x', (qb: FakeQB) => qb.where('a', '=', 1));
    registry.registerAs('b', 'zvd_x', (qb: FakeQB) => qb.where('b', '=', 2));
    expect(registry.count('zvd_x')).toBe(2);
    const removed = registry.unregisterAll('a');
    expect(removed).toBe(1);
    expect(registry.count('zvd_x')).toBe(1);

    const result = registry.applyAll(new FakeQB(), 'zvd_x', {}) as FakeQB;
    expect(result.whereCalls).toEqual([{ field: 'b', op: '=', value: 2 }]);
  });

  it('scope(extName).register tags ownership correctly', () => {
    const scope = registry.scope('crm');
    scope.register({
      table: 'zvd_contacts',
      alter: (qb: FakeQB, user: any) => qb.where('owner_id', '=', user.id),
    });
    expect(registry.list()).toEqual([{ owner: 'crm', table: 'zvd_contacts' }]);
  });

  it('scope.list() returns only this extension’s alters', () => {
    registry.scope('a').register({ table: 'zvd_x', alter: (q) => q });
    registry.scope('a').register({ table: 'zvd_y', alter: (q) => q });
    registry.scope('b').register({ table: 'zvd_x', alter: (q) => q });
    expect(registry.scope('a').list()).toEqual([{ table: 'zvd_x' }, { table: 'zvd_y' }]);
    expect(registry.scope('b').list()).toEqual([{ table: 'zvd_x' }]);
  });

  it('scope.unregisterAll() removes only this extension’s alters', () => {
    registry.scope('a').register({ table: 'zvd_x', alter: (q) => q });
    registry.scope('b').register({ table: 'zvd_x', alter: (q) => q });
    expect(registry.count()).toBe(2);
    registry.scope('a').unregisterAll();
    expect(registry.count()).toBe(1);
    expect(registry.list()).toEqual([{ owner: 'b', table: 'zvd_x' }]);
  });

  it('clear() wipes everything (test helper)', () => {
    registry.registerAs('a', 'zvd_x', (q) => q);
    registry.registerAs('b', 'zvd_y', (q) => q);
    expect(registry.count()).toBe(2);
    registry.clear();
    expect(registry.count()).toBe(0);
  });

  it('alters that ignore user still receive it without throwing', () => {
    registry.registerAs('a', 'zvd_x', (qb: FakeQB) => qb.where('static', '=', 'yes'));
    const result = registry.applyAll(new FakeQB(), 'zvd_x', null) as FakeQB;
    expect(result.whereCalls).toEqual([{ field: 'static', op: '=', value: 'yes' }]);
  });

  it('works through the dynamicSelect applyAlters callback shape', () => {
    // The data.ts list path calls dynamicSelect with:
    //   applyAlters: (qb) => queryAlterRegistry.applyAll(qb, tableName, user)
    // Verify the callback semantics match: receives a builder, returns the
    // chained builder, both rows + count queries get the same treatment.
    registry.registerAs('crm', 'zvd_contacts', (qb: FakeQB, user: any) =>
      qb.where('tenant_id', '=', user.tenantId),
    );

    const applyAlters = (qb: any) => registry.applyAll(qb, 'zvd_contacts', { tenantId: 't1' });

    const rowsQb = applyAlters(new FakeQB()) as FakeQB;
    const countQb = applyAlters(new FakeQB()) as FakeQB;

    expect(rowsQb.whereCalls).toEqual([{ field: 'tenant_id', op: '=', value: 't1' }]);
    expect(countQb.whereCalls).toEqual([{ field: 'tenant_id', op: '=', value: 't1' }]);
  });
});

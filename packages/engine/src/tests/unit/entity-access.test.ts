import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityAccessRegistryImpl } from '../../lib/tenancy/entity-access.js';

describe('EntityAccessRegistryImpl', () => {
  let registry: EntityAccessRegistryImpl;

  beforeEach(() => {
    registry = new EntityAccessRegistryImpl();
  });

  it('allows by default when no checks are registered', async () => {
    const decision = await registry.checkAccess('zvd_x', {}, {}, 'view');
    expect(decision).toBe('allow');
    expect(await registry.isAllowed('zvd_x', {}, {}, 'view')).toBe(true);
  });

  it('first deny short-circuits the chain', async () => {
    let secondCalled = false;
    registry.registerAs('a', 'zvd_x', () => 'deny');
    registry.registerAs('b', 'zvd_x', () => {
      secondCalled = true;
      return 'allow';
    });
    const decision = await registry.checkAccess('zvd_x', {}, {}, 'view');
    expect(decision).toBe('deny');
    expect(secondCalled).toBe(false);
  });

  it('all checks must allow for access to be allowed', async () => {
    registry.registerAs('a', 'zvd_x', () => 'allow');
    registry.registerAs('b', 'zvd_x', () => 'allow');
    expect(await registry.isAllowed('zvd_x', {}, {}, 'view')).toBe(true);
  });

  it('passes record + user + op to the check', async () => {
    let captured: any = null;
    registry.registerAs('a', 'zvd_payroll', (record, user, op) => {
      captured = { record, user, op };
      return 'allow';
    });
    const record = { user_id: 'u1' };
    const user = { id: 'u2', roles: ['hr'] };
    await registry.checkAccess('zvd_payroll', record, user, 'update');
    expect(captured).toEqual({ record, user, op: 'update' });
  });

  it('supports async checks', async () => {
    registry.registerAs('a', 'zvd_x', async () => {
      await Bun.sleep(5);
      return 'deny' as const;
    });
    expect(await registry.checkAccess('zvd_x', {}, {}, 'view')).toBe('deny');
  });

  it('isolates checks per table', async () => {
    registry.registerAs('a', 'zvd_x', () => 'deny');
    expect(await registry.checkAccess('zvd_y', {}, {}, 'view')).toBe('allow');
    expect(await registry.checkAccess('zvd_x', {}, {}, 'view')).toBe('deny');
  });

  it('payroll-style: HR allowed, owner can view, others denied', async () => {
    registry.registerAs('hr-policy', 'zvd_payroll', (record: any, user: any, op) => {
      if (user.roles.includes('hr')) return 'allow';
      if (op === 'view' && record.user_id === user.id) return 'allow';
      return 'deny';
    });

    const record = { user_id: 'alice', salary: 1000 };
    const hr = { id: 'h1', roles: ['hr'] };
    const owner = { id: 'alice', roles: ['employee'] };
    const stranger = { id: 'bob', roles: ['employee'] };

    expect(await registry.checkAccess('zvd_payroll', record, hr, 'view')).toBe('allow');
    expect(await registry.checkAccess('zvd_payroll', record, hr, 'update')).toBe('allow');
    expect(await registry.checkAccess('zvd_payroll', record, owner, 'view')).toBe('allow');
    expect(await registry.checkAccess('zvd_payroll', record, owner, 'update')).toBe('deny');
    expect(await registry.checkAccess('zvd_payroll', record, stranger, 'view')).toBe('deny');
  });

  it('unregisterAll(owner) drops only that extension’s checks', () => {
    registry.registerAs('a', 'zvd_x', () => 'allow');
    registry.registerAs('b', 'zvd_x', () => 'deny');
    expect(registry.count('zvd_x')).toBe(2);
    const removed = registry.unregisterAll('a');
    expect(removed).toBe(1);
    expect(registry.count('zvd_x')).toBe(1);
  });

  it('scope(extName) tags ownership and unregisters cleanly', async () => {
    const aScope = registry.scope('a');
    const bScope = registry.scope('b');
    aScope.register({ table: 'zvd_x', check: () => 'deny' });
    bScope.register({ table: 'zvd_x', check: () => 'allow' });
    expect(registry.count()).toBe(2);
    expect(aScope.list()).toEqual([{ table: 'zvd_x' }]);

    aScope.unregisterAll();
    expect(registry.count()).toBe(1);
    expect(await registry.isAllowed('zvd_x', {}, {}, 'view')).toBe(true);
  });

  it('clear() wipes everything (test helper)', () => {
    registry.registerAs('a', 'zvd_x', () => 'allow');
    registry.registerAs('b', 'zvd_y', () => 'deny');
    registry.clear();
    expect(registry.count()).toBe(0);
  });

  it('isAllowed is a thin sugar over checkAccess', async () => {
    registry.registerAs('a', 'zvd_x', () => 'deny');
    expect(await registry.isAllowed('zvd_x', {}, {}, 'view')).toBe(false);
    expect(await registry.isAllowed('zvd_y', {}, {}, 'view')).toBe(true);
  });
});

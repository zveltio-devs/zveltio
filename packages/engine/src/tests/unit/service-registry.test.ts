/**
 * Inter-extension service registry (lib/service-registry.ts).
 *
 * The engine's Drupal-style services container — a pure in-memory
 * name→{value,owner} map plus a promise-based waitFor and per-extension
 * scoped views. Every test uses a FRESH ServiceRegistryImpl so the
 * process-wide singleton isn't polluted.
 */

import { describe, expect, it } from 'bun:test';
import { ServiceRegistryImpl } from '../../lib/service-registry.js';

describe('register / get / has / list', () => {
  it('stores and retrieves a value by name', () => {
    const r = new ServiceRegistryImpl();
    expect(r.has('ai.providers')).toBe(false);
    expect(r.get('ai.providers')).toBeNull();

    const svc = { getDefault: () => 'x' };
    r.registerAs('ai', 'ai.providers', svc);
    expect(r.has('ai.providers')).toBe(true);
    expect(r.get<typeof svc>('ai.providers')).toBe(svc);
    expect(r.list()).toEqual(['ai.providers']);
  });

  it('lets the SAME owner replace its own service (hot-reload safe)', () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'ai.embed', { v: 1 });
    r.registerAs('ai', 'ai.embed', { v: 2 });
    expect(r.get<{ v: number }>('ai.embed')!.v).toBe(2);
  });

  it('throws when a DIFFERENT owner claims an existing name', () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'shared', {});
    expect(() => r.registerAs('crm', 'shared', {})).toThrow('already registered by extension "ai"');
    // the original owner still holds it
    r.registerAs('ai', 'shared', { ok: true });
    expect(r.get<{ ok: boolean }>('shared')!.ok).toBe(true);
  });
});

describe('unregister', () => {
  it('unregisterAs removes only when the owner matches', () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 's', {});
    r.unregisterAs('crm', 's'); // wrong owner → no-op
    expect(r.has('s')).toBe(true);
    r.unregisterAs('ai', 's'); // right owner → removed
    expect(r.has('s')).toBe(false);
  });

  it('unregisterAll removes every service owned by an extension only', () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'ai.a', {});
    r.registerAs('ai', 'ai.b', {});
    r.registerAs('crm', 'crm.a', {});
    r.unregisterAll('ai');
    expect(r.list()).toEqual(['crm.a']);
  });
});

describe('waitFor', () => {
  it('resolves immediately when the service is already present', async () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'ready', { now: true });
    await expect(r.waitFor<{ now: boolean }>('ready')).resolves.toEqual({ now: true });
  });

  it('resolves when the service is registered later', async () => {
    const r = new ServiceRegistryImpl();
    const pending = r.waitFor<{ late: boolean }>('later');
    r.registerAs('ai', 'later', { late: true });
    await expect(pending).resolves.toEqual({ late: true });
  });

  it('wakes multiple waiters on a single registration', async () => {
    const r = new ServiceRegistryImpl();
    const a = r.waitFor('multi');
    const b = r.waitFor('multi');
    r.registerAs('ai', 'multi', 42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
  });

  it('rejects after the timeout and cleans up its waiter', async () => {
    const r = new ServiceRegistryImpl();
    await expect(r.waitFor('never', 20)).rejects.toThrow('Timeout waiting for service "never"');
    // a later registration must not throw (waiter was removed on timeout)
    expect(() => r.registerAs('ai', 'never', {})).not.toThrow();
  });
});

describe('scope (per-extension view)', () => {
  it('attributes register/unregister to the scoped extension name', () => {
    const r = new ServiceRegistryImpl();
    const crm = r.scope('crm');
    crm.register('crm.lookup', { find: true });
    expect(r.get<{ find: boolean }>('crm.lookup')).toEqual({ find: true });

    // a different scope cannot claim the same name
    const ai = r.scope('ai');
    expect(() => ai.register('crm.lookup', {})).toThrow('already registered');

    // the owning scope can unregister it
    crm.unregister('crm.lookup');
    expect(r.has('crm.lookup')).toBe(false);
  });

  it('read methods on a scope are unrestricted', async () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'ai.x', 1);
    const view = r.scope('other');
    expect(view.has('ai.x')).toBe(true);
    expect(view.get<number>('ai.x')).toBe(1);
    expect(view.list()).toContain('ai.x');
    await expect(view.waitFor('ai.x')).resolves.toBe(1);
  });
});

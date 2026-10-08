/**
 * Inter-extension service registry (lib/service-registry.ts).
 *
 * The engine's Drupal-style services container — a pure in-memory
 * name→{value,owner} map plus a promise-based waitFor and per-extension
 * scoped views. Every test uses a FRESH ServiceRegistryImpl so the
 * process-wide singleton isn't polluted.
 */

import { describe, expect, it } from 'bun:test';
import { ServiceRegistryImpl, serviceRegisterRefusal } from '../../lib/service-registry.js';

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
    expect(() => ai.register('crm.lookup', {})).toThrow(
      'may register only services named "ai.<name>"',
    );

    // the owning scope can unregister it
    crm.unregister('crm.lookup');
    expect(r.has('crm.lookup')).toBe(false);
  });

  it('an extension registers only under its own name', () => {
    const r = new ServiceRegistryImpl();
    expect(() => r.scope('operations/pos').register('pos.sale', 1)).toThrow(
      'may register only services named "operations/pos.<name>"',
    );
    // `a.` would prefix `a.b.`'s names, so a dotted extension name gets no namespace.
    expect(() => r.scope('a.b').register('a.b.x', 1)).toThrow('may register only');
    // A name with no dot is in nobody's namespace — not in `share`'s because it starts so.
    expect(() => r.scope('share').register('shared', 1)).toThrow('may register only');
    r.scope('operations/pos').register('operations/pos.sale', 1);
    expect(r.ownerOf('operations/pos.sale')).toBe('operations/pos');
  });

  it("reads only its own, its declared owners', and nothing undeclared", async () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('crm', 'crm.contacts.lookup', 'crm');
    r.registerAs('ai', 'ai.providers', 'ai');
    r.registerAs('engine', 'engine.internal', 'engine');
    const pos = r.scope('operations/pos', ['crm']);
    expect(pos.get<string>('crm.contacts.lookup')).toBe('crm');
    expect(pos.has('crm.contacts.lookup')).toBe(true);
    await expect(pos.waitFor('crm.contacts.lookup')).resolves.toBe('crm');
    expect(() => pos.get('ai.providers')).toThrow(
      'declare "ai" in its manifest dependencies or optionalDependencies',
    );
    expect(() => pos.has('ai.providers')).toThrow('may not call service "ai.providers"');
    await expect(pos.waitFor('ai.providers')).rejects.toThrow('may not call');
    // declaring `engine` opens nothing of the engine's own
    expect(() => r.scope('x', ['engine']).get('engine.internal')).toThrow('not an engine-public');
    // a name nobody registered is absent — an optional dependency not installed
    expect(pos.get('crm.contacts.create')).toBeNull();
    expect(pos.list()).toContain('ai.providers');
  });

  it('the engine scope is unrestricted', () => {
    const r = new ServiceRegistryImpl();
    r.registerAs('ai', 'ai.x', 1);
    expect(r.scope('engine').get<number>('ai.x')).toBe(1);
  });
});

describe('a third party named like an old first-party service prefix', () => {
  // The old first-party names (`inventory.*`) were leaf names anyone could
  // claim. Renamed into `operations/inventory.*`, an extension called
  // `inventory` owns `inventory.*` only — and no first-party caller reads it,
  // because the caller may read only the owners it declared.
  it('can register in its own namespace but is not what a first-party caller reaches', () => {
    const r = new ServiceRegistryImpl();
    r.scope('inventory').register('inventory.products.list', 'squat');
    r.scope('operations/inventory').register('operations/inventory.products.list', 'list');
    const invoicing = r.scope('finance/invoicing', ['operations/inventory']);
    expect(invoicing.get<string>('operations/inventory.products.list')).toBe('list');
    expect(() => invoicing.get('inventory.products.list')).toThrow('declare "inventory"');
  });
});

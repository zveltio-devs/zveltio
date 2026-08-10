/**
 * Listener tracking across a hot reload.
 *
 * `register()` runs again on every reload. Nothing removed the listeners the
 * previous load had registered, so they accumulated: after two reloads a single
 * invoice fired the same handler three times, and the extension looked like it
 * had a duplication bug of its own.
 *
 * The wrapper that makes this work is also where the second bug lived. It was
 * written as `{ ...ctx.events, on }` — a spread, which copies own enumerable
 * properties only, while the bus is a class instance whose methods live on the
 * prototype. Extensions received an object with exactly the two methods defined
 * in the wrapper and nothing else, so `ctx.events.emitAsync` was "not a function"
 * for every one of them. It only surfaced on a virgin install, because a
 * database that already had the rows never reached the code that emits.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'bun:test';
// The engine's own context type, which is what `buildRestrictedContext` takes —
// the SDK exports a generic one under the same name.
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import {
  buildRestrictedContext,
  unregisterExtensionListeners,
} from '../../lib/extensions/register.js';

/** A bus with a prototype, like the real one — that is the whole point. */
class FakeBus {
  handlers = new Map<string, Set<(p: unknown) => unknown>>();

  on(event: string, handler: (p: unknown) => unknown) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  /** Present on the prototype only — a spread would drop it. */
  async emitAsync(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) await h(payload);
  }

  count(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function contextWith(bus: FakeBus): ExtensionContext {
  return { events: bus } as unknown as ExtensionContext;
}

function restricted(bus: FakeBus, name: string) {
  return buildRestrictedContext(contextWith(bus), name, new Hono(), undefined, false);
}

describe('extension listener tracking', () => {
  it('keeps the methods that live on the bus prototype', () => {
    const bus = new FakeBus();
    const ctx = restricted(bus, 'probe/proto');
    // The spread this replaced produced an object with `on` and `onBefore` and
    // nothing else, which is how every extension lost `emitAsync`.
    expect(typeof (ctx.events as unknown as FakeBus).emitAsync).toBe('function');
  });

  it('still forwards registrations to the real bus', async () => {
    const bus = new FakeBus();
    const ctx = restricted(bus, 'probe/forward');
    const seen: string[] = [];
    (ctx.events as unknown as FakeBus).on('record.created', () => {
      seen.push('hit');
    });
    await bus.emitAsync('record.created', {});
    expect(seen).toEqual(['hit']);
    unregisterExtensionListeners('probe/forward');
  });

  it('removes exactly what one extension registered, on unload', () => {
    const bus = new FakeBus();
    const a = restricted(bus, 'probe/a');
    const b = restricted(bus, 'probe/b');
    (a.events as unknown as FakeBus).on('record.created', () => {});
    (b.events as unknown as FakeBus).on('record.created', () => {});
    expect(bus.count('record.created')).toBe(2);

    expect(unregisterExtensionListeners('probe/a')).toBe(1);
    expect(bus.count('record.created')).toBe(1);

    unregisterExtensionListeners('probe/b');
    expect(bus.count('record.created')).toBe(0);
  });

  it('does not accumulate a handler per reload', () => {
    // Three loads of the same extension, as a hot reload does. Before the
    // tracking, this left three live handlers and one invoice fired all three.
    const bus = new FakeBus();
    for (let i = 0; i < 3; i++) {
      const ctx = restricted(bus, 'probe/reload');
      (ctx.events as unknown as FakeBus).on('record.created', () => {});
    }
    expect(bus.count('record.created')).toBe(1);
    unregisterExtensionListeners('probe/reload');
    expect(bus.count('record.created')).toBe(0);
  });

  it('reports nothing to remove for an extension that never registered', () => {
    expect(unregisterExtensionListeners('probe/never')).toBe(0);
  });
});

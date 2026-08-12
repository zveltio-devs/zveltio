/**
 * `ctx.db` is a Proxy, and everything an extension touches on it goes through
 * one `get` trap. The trap binds function-valued properties so `this` survives,
 * which is right for a method and quietly destructive for a callable object
 * carrying methods of its own.
 *
 * Kysely's `db.fn` is that second kind: callable, with `count`, `sum`, `avg`,
 * `max`, `min`, `agg` and `coalesce` as own properties. `Function.prototype.bind`
 * returns a fresh function and copies none of them, so `ctx.db.fn` arrived as a
 * function whose methods had all vanished — and every extension aggregating
 * through the proxy answered 500.
 *
 * The shape is what matters here, not Kysely: any callable the engine hands an
 * extension can carry properties, and a proxy that eats them is a trap nobody
 * can see from the extension side.
 */

import { describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

/** Stand-in for the shape that broke: callable, with methods hanging off it. */
function makeCallableWithMethods() {
  const f = function callable(this: unknown) {
    return 'called';
  } as unknown as {
    (): string;
    count: (c: string) => string;
    sum: (c: string) => string;
  };
  f.count = (c: string) => `count(${c})`;
  f.sum = (c: string) => `sum(${c})`;
  return f;
}

// biome-ignore lint/suspicious/noExplicitAny: hand-built stand-in for a Kysely handle
function fakeDb(): any {
  return {
    fn: makeCallableWithMethods(),
    plainMethod(this: { marker: string }) {
      return this.marker;
    },
    marker: 'bound-to-target',
    notAFunction: { a: 1 },
  };
}

describe('extension db proxy — callable properties', () => {
  it('keeps the methods hanging off a callable property', () => {
    // biome-ignore lint/suspicious/noExplicitAny: proxy is typed against Database
    const db = createRestrictedDb(fakeDb() as any, 'probe') as any;

    expect(typeof db.fn).toBe('function');
    // The regression: `bind` dropped these and the failure surfaced far away,
    // as "db.fn.count is not a function" inside an extension.
    expect(typeof db.fn.count).toBe('function');
    expect(db.fn.count('id')).toBe('count(id)');
    expect(db.fn.sum('tokens')).toBe('sum(tokens)');
  });

  it('still calls the callable itself', () => {
    // biome-ignore lint/suspicious/noExplicitAny: proxy is typed against Database
    const db = createRestrictedDb(fakeDb() as any, 'probe') as any;
    expect(db.fn()).toBe('called');
  });

  it('still binds `this` for an ordinary method — the reason bind is there', () => {
    // biome-ignore lint/suspicious/noExplicitAny: proxy is typed against Database
    const db = createRestrictedDb(fakeDb() as any, 'probe') as any;
    const detached = db.plainMethod;
    // Detached from the object and still resolving `this` to the real handle.
    expect(detached()).toBe('bound-to-target');
  });

  it('passes non-function properties through untouched', () => {
    // biome-ignore lint/suspicious/noExplicitAny: proxy is typed against Database
    const db = createRestrictedDb(fakeDb() as any, 'probe') as any;
    expect(db.notAFunction).toEqual({ a: 1 });
  });
});

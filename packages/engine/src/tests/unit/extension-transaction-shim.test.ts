import { describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

/**
 * `ctx.db.transaction()` JOINS the request's transaction rather than opening
 * one — which is correct, and is what lets an extension group writes that commit
 * with the request that triggered them.
 *
 * What it cannot do is change that transaction's isolation level or access mode:
 * both are fixed when a transaction begins. The shim used to accept both calls
 * and return itself, so an extension writing `.setAccessMode('read only')` got a
 * read-write transaction and no error, and one relying on
 * `setIsolationLevel('serializable')` for a read-modify-write got the default
 * and the race it had explicitly asked not to have.
 *
 * Nothing in the 56 first-party extensions calls either today, so refusing
 * breaks nobody now and stops the first caller from believing it.
 */
describe('the extension transaction shim', () => {
  /** A handle that looks like a tenant transaction to the proxy. */
  function tenantTrxHandle() {
    return {
      isTransaction: true,
      // Present so the proxy's own probe recognises a transaction.
      // biome-ignore lint/suspicious/noExplicitAny: a stand-in for Kysely's handle
      connection: () => ({}) as any,
      selectFrom: () => ({}),
    };
  }

  it('still joins the request transaction and runs the callback', async () => {
    const target = tenantTrxHandle();
    // biome-ignore lint/suspicious/noExplicitAny: the proxy takes a Database
    const db = createRestrictedDb(target as any, 'probe-ext', new Set<string>());
    // biome-ignore lint/suspicious/noExplicitAny: shim shape
    const trx = (db as any).transaction();
    // Asserted, not guarded. A silent `return` here would let both cases pass
    // without ever reaching the shim — which is the failure class this campaign
    // named, so it should not appear in a test written after naming it.
    expect(typeof trx?.execute).toBe('function');
    const seen = await trx.execute(async (t: unknown) => (t === target ? 'joined' : 'other'));
    expect(seen).toBe('joined');
  });

  it('refuses a setting it cannot honour, naming it', () => {
    const target = tenantTrxHandle();
    // biome-ignore lint/suspicious/noExplicitAny: the proxy takes a Database
    const db = createRestrictedDb(target as any, 'probe-ext', new Set<string>());
    // biome-ignore lint/suspicious/noExplicitAny: shim shape
    const trx = (db as any).transaction();
    expect(typeof trx?.setAccessMode).toBe('function');
    expect(() => trx.setAccessMode('read only')).toThrow(/setAccessMode/);
    expect(() => trx.setIsolationLevel('serializable')).toThrow(/setIsolationLevel/);
    // And it says why, so the caller is not left to guess at a shim they cannot see.
    expect(() => trx.setAccessMode('read only')).toThrow(/joins the request/);
  });
});

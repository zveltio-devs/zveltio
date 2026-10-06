/**
 * `ctx.internals.asSystem` — an extension acting as the system, inside the
 * tenant it runs as, for named collections.
 *
 * Collection permissions are moving into the database (roadmap R1): a policy on
 * every collection table will refuse what the caller's roles do not grant, so an
 * extension's `ctx.db` in a user's request can do exactly what that user can.
 * Some work is legitimately more than that — a shop decrementing stock the
 * customer may not edit, a form updating a counter. That work says so, here:
 *
 *   await ctx.internals.asSystem(['products'], async () => {
 *     await ctx.db.updateTable('zvd_products')...;
 *   }, { reason: 'stock decrement at checkout' });
 *
 * What "system" means is deliberately small:
 *
 *   - **Only collection permissions stand down**, and only for the collections
 *     named. Tenant isolation does not: the statements still run in the
 *     request's tenant transaction, as `zveltio_rls`, under the tenant policy.
 *     The `ctx.db` table guard (#858) does not either: the extension still
 *     reaches only the tables it could reach before.
 *   - **It needs the `data:system` capability**, declared and approved like any
 *     other, so an administrator sees which extensions can act beyond their
 *     users.
 *   - **Every entry is audited** — extension, user, collections, reason — so an
 *     extension that leans on it is visible in the tenant's trail.
 *
 * The mark is the `zveltio.system_collections` setting, which only the engine
 * writes: `set_config` is one of the functions `ctx.db` refuses to an extension
 * (`worker-sql-policy.ts`). It is restored when `fn` settles, so the window is
 * the call. Everything on the transaction during that window shares it — which
 * is the request's own work; nothing from another request runs on it.
 *
 * Until R1 enforces, the setting is read by nothing. This lands first so
 * extensions can move to it before the policy applies (owner decision,
 * 2026-10-04: add the way out, then close the door).
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCurrentTenantTrx } from '../tenancy/index.js';
import { auditAs } from './tenant-facts.js';

/** The setting the collection-permission policy reads. */
export const SYSTEM_COLLECTIONS_SETTING = 'zveltio.system_collections';

export interface AsSystemOptions {
  /** Why — recorded in the audit row. Up to 200 characters. */
  reason?: string;
}

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The collection list as the setting carries it: `,a,b,` for exact matching. */
export function encodeSystemCollections(names: readonly string[]): string {
  return names.length === 0 ? '' : `,${[...new Set(names)].sort().join(',')},`;
}

/**
 * The calls open on each tenant transaction. The mark is written from this
 * after every entry and exit, never restored from a value read on entry: two
 * calls that overlap (`Promise.all`) exit in either order, and restoring the
 * first one's snapshot last put its collections back for the rest of the request.
 */
const openCalls = new WeakMap<object, (readonly string[])[]>();

function writeMark(trx: Database, calls: readonly (readonly string[])[]) {
  return sql`SELECT set_config(${SYSTEM_COLLECTIONS_SETTING}, ${encodeSystemCollections(calls.flat())}, true)`.execute(
    trx,
  );
}

/**
 * Run `fn` with collection permissions standing down for `collections`, in the
 * running tenant's transaction. Bound to the calling extension by
 * `buildExtensionInternals`.
 */
export async function asSystemAs<T>(
  caller: string,
  collections: readonly string[],
  fn: () => Promise<T>,
  opts: AsSystemOptions = {},
): Promise<T> {
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new Error(`ext:${caller}: ctx.internals.asSystem needs the collections it acts on`);
  }
  // Collection names, not tables: `products`, not `zvd_products`. A name this
  // cannot be (a table, a wildcard, a list in one string) is refused rather
  // than guessed at — a `*` here would be a blanket exemption.
  const bad = collections.find(
    (c) => typeof c !== 'string' || !NAME.test(c) || c.startsWith('zvd_'),
  );
  if (bad !== undefined) {
    throw new Error(
      `ext:${caller}: ctx.internals.asSystem: ${JSON.stringify(bad)} is not a collection name`,
    );
  }
  if (typeof fn !== 'function') {
    throw new Error(`ext:${caller}: ctx.internals.asSystem needs a function to run`);
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.slice(0, 200) : undefined;

  // The tenant's transaction, or nothing: "system" is system INSIDE a tenant,
  // and outside one there is no tenant to be inside of.
  const trx = getCurrentTenantTrx();
  if (!trx) {
    throw new Error(
      `ext:${caller}: ctx.internals.asSystem runs only inside a tenant's work — a request, ` +
        'or a job inside ctx.internals.withTenantIsolation',
    );
  }

  const before = await sql<{ uid: string | null }>`
    SELECT current_setting('zveltio.user_id', true) AS uid
  `.execute(trx);
  const userId = before.rows[0]?.uid || undefined;

  // Nested and overlapping calls widen, never narrow: the mark is every open
  // call's collections, so an inner call keeps the outer's for its duration.
  const mine = [...collections];
  const calls = openCalls.get(trx) ?? [];
  openCalls.set(trx, calls);
  calls.push(mine);
  try {
    await writeMark(trx, calls);
  } catch (err) {
    calls.splice(calls.indexOf(mine), 1);
    throw err;
  }

  // Not awaited into the result: a failed audit write must not fail the work,
  // and `auditAs` writes in a transaction of its own. Logged when it fails.
  auditAs(caller, {
    type: 'extension.as_system',
    userId,
    resourceType: 'collection',
    resourceId: [...collections].sort().join(','),
    metadata: { collections: [...collections].sort(), ...(reason ? { reason } : {}) },
  }).catch((err) => {
    console.warn(`[asSystem] audit for ext:${caller} failed:`, (err as Error)?.message ?? err);
  });

  try {
    return await fn();
  } finally {
    // Rewritten, not cleared: another call's window may still be open. If the
    // transaction is aborted this fails too — and the transaction's own
    // rollback discards the setting with everything else.
    calls.splice(calls.indexOf(mine), 1);
    await writeMark(trx, calls).catch(() => undefined);
  }
}

/**
 * extension-context.ts
 *
 * Provides a RestrictedDb proxy that wraps the engine's Kysely Database.
 *
 * Access policy:
 *   - Extensions may freely access non-prefixed tables (e.g. `user`, `account`).
 *   - Extensions may freely access `zvd_*` user-data tables.
 *   - Extensions may access `zv_<extname>_*` (and the dotted/slashed variant
 *     where slashes are normalized to underscores) — their OWN reserved namespace.
 *   - Extensions may NOT access any other `zv_*` system tables: secrets,
 *     permissions, audit logs, API keys, billing data, session tokens, etc.
 *
 * Hook interception (S2-02 follow-up): writes against `zvd_*` user tables
 * fire `record.beforeInsert` / `record.beforeUpdate` / `record.beforeDelete`
 * pre-write hooks the same way HTTP routes do, so business-logic hooks
 * registered by other extensions are not silently bypassed when a write
 * comes from `ctx.db.insertInto(...).execute()` instead of an HTTP route.
 *
 *   - Insert: hook always fires (cheap — we already have the data).
 *   - Update / Delete: hook fires when the WHERE clause is a clear
 *     single-row match by id (the common case). Bulk WHERE-clause writes
 *     skip the hook with a console warning — extensions doing maintenance
 *     work should be deliberate about it.
 *
 * Fast path: if no hook is registered for the relevant event, the proxy
 * returns the raw Kysely builder — zero overhead in the steady state.
 *
 * Note: only Kysely query-builder methods are intercepted. Raw
 * `sql\`...\`.execute(db)` passes through without inspection.
 */

import type { Database } from '../../db/index.js';
import { engineEvents, AbortHookError } from '../runtime/index.js';

// All Kysely query-builder entry points that accept a table name as first arg.
const QUERY_METHODS = [
  'selectFrom',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'replaceInto',
  'mergeInto',
  'withSchema',
] as const;

type RestrictedDatabase = Database;

/** Tables that extensions are allowed to fire write hooks against. We
 *  only fire hooks on `zvd_*` (user data) and the extension's own
 *  `zv_<extname>_*` namespace; system tables already throw before we get
 *  here. The restriction matters because firing `record.beforeInsert`
 *  on, say, `account` would surprise hook authors who only ever expect
 *  user-data tables. */
function shouldFireHooks(tableName: string): boolean {
  return tableName.startsWith('zvd_');
}

/**
 * Create a RestrictedDb proxy around the given Database.
 *
 * Any call to a Kysely query-builder method whose table argument starts with
 * `zv_` throws an ExtensionSecurityError, preventing extensions from reading
 * or writing system tables.
 *
 * @param db   The real Database instance.
 * @param extName  Extension name — included in error messages for debugging.
 */
export function createRestrictedDb(
  db: Database,
  extName: string,
  allowedTables?: Set<string>,
): RestrictedDatabase {
  // An extension named "ai" owns `zv_ai_*`. An extension named "compliance/ro/saft"
  // owns `zv_compliance_ro_saft_*` (slashes normalized to underscores).
  const ownedPrefix = `zv_${extName.replace(/[^a-z0-9]/gi, '_')}_`;

  return new Proxy(db, {
    get(target, prop: string | symbol) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const value = (target as any)[prop];

      if (typeof prop === 'string' && (QUERY_METHODS as readonly string[]).includes(prop)) {
        // Return a wrapper that validates the table argument before forwarding.
        return function restrictedQueryMethod(tableName: string, ...rest: unknown[]) {
          const table = typeof tableName === 'string' ? tableName : '';
          // Strip alias syntax e.g. "zv_users as u"
          const baseTable = table.split(/\s+/)[0].trim();

          if (
            baseTable.startsWith('zv_') &&
            !baseTable.startsWith(ownedPrefix) &&
            !allowedTables?.has(baseTable)
          ) {
            throw new ExtensionSecurityError(
              `Extension "${extName}" attempted to access system table "${baseTable}" via ${prop}(). ` +
                `Extensions may only access user data tables (zvd_*) and their own namespace (${ownedPrefix}*). ` +
                `Other zv_* system tables are reserved for Zveltio engine internals.`,
            );
          }

          // S2-02 hook interception: only wrap writes against user-data
          // tables (zvd_*). Fast path otherwise — no wrapping cost.
          if (shouldFireHooks(baseTable)) {
            if (prop === 'insertInto' && engineEvents.preHookCount('record.beforeInsert') > 0) {
              return wrapInsertForHooks(target, baseTable, extName);
            }
            if (prop === 'updateTable' && engineEvents.preHookCount('record.beforeUpdate') > 0) {
              return wrapUpdateForHooks(target, baseTable, extName);
            }
            if (prop === 'deleteFrom' && engineEvents.preHookCount('record.beforeDelete') > 0) {
              return wrapDeleteForHooks(target, baseTable, extName);
            }
          }

          return (value as (...args: unknown[]) => unknown).call(target, tableName, ...rest);
        };
      }

      if (typeof value === 'function') {
        return value.bind(target);
      }

      return value;
    },
  }) as RestrictedDatabase;
}

// ── Insert hook interception ───────────────────────────────────────────────
//
// Strategy: record every chain method call. At `.execute*()` time, run the
// hook, then replay the entire chain against a fresh `insertInto` builder
// (possibly with mutated `values` data). The replay is necessary because
// Kysely builders are immutable — there's no way to mutate `values` data
// in place.

interface ChainCall {
  method: string;
  args: unknown[];
}

const TERMINAL_METHODS = new Set(['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow']);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function wrapInsertForHooks(db: any, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') {
          // Pass through Symbol-keyed properties (e.g. Symbol.iterator on
          // returned array proxies). They never appear on builders we care
          // about, but being defensive keeps the wrapper transparent.
          return Reflect.get(t, prop);
        }

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            // Pull current `values()` arg from the recorded chain.
            const valuesIdx = chainCalls.findIndex((c) => c.method === 'values');
            const originalData =
              valuesIdx >= 0 ? (chainCalls[valuesIdx].args[0] as Record<string, unknown>) : {};

            try {
              const payload = await engineEvents.runBefore('record.beforeInsert', {
                collection: table,
                data: originalData,
                userId: `system:${extName}`,
              });
              // Rebuild the chain with the (possibly mutated) data.
              let q = db.insertInto(table);
              for (let i = 0; i < chainCalls.length; i++) {
                const call = chainCalls[i];
                if (i === valuesIdx) q = q.values(payload.data);
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
                else q = (q as any)[call.method](...call.args);
              }
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
              return await (q as any)[prop](...termArgs);
            } catch (err) {
              if (err instanceof AbortHookError) throw err;
              throw err;
            }
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.insertInto(table));
}

// ── Update hook interception ───────────────────────────────────────────────
//
// Only handles the single-row case: `db.updateTable('zvd_x').set({...})
// .where('id', '=', someId).execute()`. We detect the `id` from the WHERE
// chain. If the WHERE is more complex than that, we skip the hook (with a
// console warning the first time it happens for a given table+ext).

const _bulkWriteWarned = new Set<string>();

function warnBulkSkip(kind: 'update' | 'delete', table: string, extName: string): void {
  const key = `${kind}:${table}:${extName}`;
  if (_bulkWriteWarned.has(key)) return;
  _bulkWriteWarned.add(key);
  console.warn(
    `[hook-intercept] Extension "${extName}" issued a bulk ${kind} on "${table}". ` +
      `record.before${kind === 'update' ? 'Update' : 'Delete'} hooks ` +
      `only fire on single-row WHERE-by-id writes; this one will skip hooks. ` +
      `Pre-fetch ids and loop if you need per-row hook semantics.`,
  );
}

/** Try to extract a single id from chain WHERE calls. Returns `null` if
 *  the WHERE clause is anything more complex than `where('id', '=', X)`. */
function extractSingleId(chainCalls: ChainCall[]): string | null {
  const whereCalls = chainCalls.filter((c) => c.method === 'where');
  if (whereCalls.length !== 1) return null;
  const args = whereCalls[0].args;
  if (args.length !== 3) return null;
  if (args[0] !== 'id' || args[1] !== '=') return null;
  const v = args[2];
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  return String(v);
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function wrapUpdateForHooks(db: any, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop);

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            const id = extractSingleId(chainCalls);
            if (!id) {
              warnBulkSkip('update', table, extName);
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
              return await (t as any)[prop](...termArgs);
            }
            // Single-row update: fire hook with `before` snapshot.
            const setIdx = chainCalls.findIndex((c) => c.method === 'set');
            const originalPatch =
              setIdx >= 0 ? (chainCalls[setIdx].args[0] as Record<string, unknown>) : {};
            const before = (await db
              .selectFrom(table)
              .selectAll()
              .where('id', '=', id)
              .executeTakeFirst()
              .catch(() => undefined)) as Record<string, unknown> | undefined;
            const payload = await engineEvents.runBefore('record.beforeUpdate', {
              collection: table,
              id,
              before: before ?? {},
              patch: originalPatch,
              userId: `system:${extName}`,
            });
            // Replay chain with mutated patch.
            let q = db.updateTable(table);
            for (let i = 0; i < chainCalls.length; i++) {
              const call = chainCalls[i];
              if (i === setIdx) q = q.set(payload.patch);
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
              else q = (q as any)[call.method](...call.args);
            }
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
            return await (q as any)[prop](...termArgs);
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.updateTable(table));
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function wrapDeleteForHooks(db: any, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop);

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            const id = extractSingleId(chainCalls);
            if (!id) {
              warnBulkSkip('delete', table, extName);
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
              return await (t as any)[prop](...termArgs);
            }
            const record = (await db
              .selectFrom(table)
              .selectAll()
              .where('id', '=', id)
              .executeTakeFirst()
              .catch(() => undefined)) as Record<string, unknown> | undefined;
            await engineEvents.runBefore('record.beforeDelete', {
              collection: table,
              id,
              record: record ?? {},
              userId: `system:${extName}`,
            });
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
            return await (t as any)[prop](...termArgs);
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.deleteFrom(table));
}

export class ExtensionSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionSecurityError';
  }
}

// Internal helpers exposed for tests only.
export const _internalForTests = { extractSingleId, shouldFireHooks };

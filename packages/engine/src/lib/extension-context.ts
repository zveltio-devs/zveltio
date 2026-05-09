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
 * Note: only Kysely query-builder methods are intercepted. Raw `sql\`...\`.execute(db)`
 * passes through the proxy without inspection — extensions should still avoid
 * those for system tables, but the security boundary is best-effort, not a hard
 * sandbox.
 */

import type { Database } from '../db/index.js';

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
export function createRestrictedDb(db: Database, extName: string): RestrictedDatabase {
  // An extension named "ai" owns `zv_ai_*`. An extension named "compliance/ro/saft"
  // owns `zv_compliance_ro_saft_*` (slashes normalized to underscores).
  const ownedPrefix = `zv_${extName.replace(/[^a-z0-9]/gi, '_')}_`;

  return new Proxy(db, {
    get(target, prop: string | symbol) {
      const value = (target as any)[prop];

      if (typeof prop === 'string' && (QUERY_METHODS as readonly string[]).includes(prop)) {
        // Return a wrapper that validates the table argument before forwarding.
        return function restrictedQueryMethod(tableName: string, ...rest: unknown[]) {
          const table = typeof tableName === 'string' ? tableName : '';
          // Strip alias syntax e.g. "zv_users as u"
          const baseTable = table.split(/\s+/)[0].trim();

          if (baseTable.startsWith('zv_') && !baseTable.startsWith(ownedPrefix)) {
            throw new ExtensionSecurityError(
              `Extension "${extName}" attempted to access system table "${baseTable}" via ${prop}(). ` +
              `Extensions may only access user data tables (zvd_*) and their own namespace (${ownedPrefix}*). ` +
              `Other zv_* system tables are reserved for Zveltio engine internals.`,
            );
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

export class ExtensionSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionSecurityError';
  }
}

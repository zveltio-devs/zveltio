/**
 * extension-context.ts
 *
 * Provides a RestrictedDb proxy that wraps the engine's Kysely Database and
 * blocks extensions from querying or mutating system tables (zv_* prefix).
 * Extensions may freely access user-created data tables (zvd_* prefix) and
 * any tables that don't start with the system prefix.
 *
 * System tables contain secrets, permissions, audit logs, API keys, billing
 * data, and session tokens — extensions must never touch these directly.
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
  return new Proxy(db, {
    get(target, prop: string | symbol) {
      const value = (target as any)[prop];

      if (typeof prop === 'string' && (QUERY_METHODS as readonly string[]).includes(prop)) {
        // Return a wrapper that validates the table argument before forwarding.
        return function restrictedQueryMethod(tableName: string, ...rest: unknown[]) {
          const table = typeof tableName === 'string' ? tableName : '';
          // Strip alias syntax e.g. "zv_users as u"
          const baseTable = table.split(/\s+/)[0].trim();

          if (baseTable.startsWith('zv_')) {
            throw new ExtensionSecurityError(
              `Extension "${extName}" attempted to access system table "${baseTable}" via ${prop}(). ` +
              `Extensions may only access user data tables (zvd_*). ` +
              `System tables are reserved for Zveltio engine internals.`,
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

import type { Database } from '../db/index.js';

/**
 * Creates a simple loader for a single collection, batching id lookups into one query.
 * Returns null (not undefined) for IDs that do not exist, preserving order.
 * No external dependencies - uses native Map for caching.
 */
export function createCollectionLoader(
  db: Database,
  tableName: string,
  keyField: string = 'id',
): (keys: readonly string[]) => Promise<Array<Record<string, any> | null>> {
  return async (keys: readonly string[]) => {
    try {
      const rows: Record<string, any>[] = await (db as any)
        .selectFrom(tableName)
        .selectAll()
        .where(keyField, 'in', keys as string[])
        .execute();

      const map = new Map<string, Record<string, any>>();
      for (const row of rows) {
        map.set(String(row[keyField]), row);
      }
      return keys.map((k) => map.get(String(k)) ?? null);
    } catch {
      return keys.map(() => null);
    }
  };
}

/**
 * Per-request registry: one loader per collection, recreated each request.
 * Simplified version without DataLoader dependency.
 */
export class DataLoaderRegistry {
  private loaders = new Map<
    string,
    (keys: readonly string[]) => Promise<Array<Record<string, any> | null>>
  >();

  constructor(private db: Database) {}

  get(
    tableName: string,
  ): (keys: readonly string[]) => Promise<Array<Record<string, any> | null>> {
    if (!this.loaders.has(tableName)) {
      this.loaders.set(tableName, createCollectionLoader(this.db, tableName));
    }
    return this.loaders.get(tableName)!;
  }
}

/**
 * Simple query depth validator - counts nesting level without external dependencies.
 * Returns an error message if depth exceeds maxDepth, null otherwise.
 */
export function checkQueryDepth(
  query: string,
  maxDepth: number = 5,
): string | null {
  try {
    let currentDepth = 0;
    let maxFound = 0;
    let inString = false;
    let escapeNext = false;

    for (const char of query) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          currentDepth++;
          maxFound = Math.max(maxFound, currentDepth);
        } else if (char === '}') {
          currentDepth = Math.max(0, currentDepth - 1);
        }
      }
    }

    return maxFound > maxDepth
      ? `Query exceeds maximum depth of ${maxDepth}`
      : null;
  } catch {
    return null;
  }
}

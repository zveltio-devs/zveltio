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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
): (keys: readonly string[]) => Promise<Array<Record<string, any> | null>> {
  return async (keys: readonly string[]) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const rows: Record<string, any>[] = await (db as any)
        .selectFrom(tableName)
        .selectAll()
        .where(keyField, 'in', keys as string[])
        .execute();

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    (keys: readonly string[]) => Promise<Array<Record<string, any> | null>>
  >();

  constructor(private db: Database) {}

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get(tableName: string): (keys: readonly string[]) => Promise<Array<Record<string, any> | null>> {
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
export function checkQueryDepth(query: string, maxDepth: number = 5): string | null {
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

    return maxFound > maxDepth ? `Query exceeds maximum depth of ${maxDepth}` : null;
  } catch {
    return null;
  }
}

/**
 * Reject a query that asks for too many top-level fields.
 *
 * Depth was already limited, and each list resolver already clamps to 500 rows.
 * Neither bounds the WIDTH: a single POST can alias the same root field six
 * hundred times, and every alias is a separate query at the full row cap. An
 * audit measured 600 aliases returning 200 OK in 0.42 s — up to three hundred
 * thousand rows for one request that the rate limiter counted as one request,
 * because it counts requests and this is about cost.
 *
 * Counted rather than parsed, in the same spirit as `checkQueryDepth` above:
 * this runs before the schema is built, on a string that may not even be valid
 * GraphQL, and a cheap conservative count is the right tool at that point. It
 * walks the top level only — `{` and `}` track nesting, so fields inside a
 * selection are somebody else's problem (the depth check's).
 *
 * Fifty is far above any interface a person drives and far below a query that
 * hurts. A caller that genuinely needs more should send more requests, which is
 * exactly what the rate limiter is there to price.
 */
export function checkQueryWidth(query: string, maxFields: number = 50): string | null {
  try {
    let depth = 0;
    let rootFields = 0;
    let inString = false;
    let escapeNext = false;
    let atFieldStart = true;
    let skipNextIdent = false;

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
      if (inString) continue;

      if (char === '{') {
        depth++;
        atFieldStart = true;
        continue;
      }
      if (char === '}') {
        depth = Math.max(0, depth - 1);
        atFieldStart = true;
        continue;
      }

      // Depth 1 is the root selection set. A run of identifier characters that
      // begins there is one root field; separators reset so the next run counts
      // as a new one.
      if (depth === 1) {
        const isIdent = /[A-Za-z0-9_]/.test(char);
        if (char === ':') {
          // What came before was an alias, so the field that follows is the
          // same selection. Counting both would halve the stated limit.
          skipNextIdent = true;
          atFieldStart = true;
        } else if (isIdent && atFieldStart) {
          if (skipNextIdent) {
            skipNextIdent = false;
          } else {
            rootFields++;
          }
          atFieldStart = false;
        } else if (!isIdent) {
          atFieldStart = true;
        }
      }
    }

    return rootFields > maxFields
      ? `Query requests ${rootFields} top-level fields, which is over the limit of ${maxFields}. Split it across requests.`
      : null;
  } catch {
    return null;
  }
}

import DataLoader from 'dataloader';
import type { Database } from '../db/index.js';

/**
 * Creates a DataLoader for a single collection, batching id lookups into one query.
 * Returns null (not undefined) for IDs that do not exist, preserving order.
 */
export function createCollectionLoader(
  db: Database,
  tableName: string,
  keyField: string = 'id',
): DataLoader<string, Record<string, any> | null> {
  return new DataLoader<string, Record<string, any> | null>(
    async (keys: readonly string[]) => {
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
    },
    { cache: true },
  );
}

/**
 * Per-request registry: one DataLoader per collection, recreated each request
 * so caches don't bleed across requests.
 */
export class DataLoaderRegistry {
  private loaders = new Map<string, DataLoader<string, Record<string, any> | null>>();

  constructor(private db: Database) {}

  get(tableName: string): DataLoader<string, Record<string, any> | null> {
    if (!this.loaders.has(tableName)) {
      this.loaders.set(tableName, createCollectionLoader(this.db, tableName));
    }
    return this.loaders.get(tableName)!;
  }
}

/**
 * Simple query depth validator — checks the parsed AST before execution.
 * Returns an error message if depth exceeds maxDepth, null otherwise.
 */
export function checkQueryDepth(
  query: string,
  maxDepth: number = 5,
): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require('graphql') as typeof import('graphql');
    const doc = parse(query);

    let exceeded = false;

    const visitSelections = (
      selections: readonly import('graphql').SelectionNode[],
      depth: number,
    ): void => {
      if (depth > maxDepth) {
        exceeded = true;
        return;
      }
      for (const sel of selections) {
        if (sel.kind === 'Field' && sel.selectionSet) {
          visitSelections(sel.selectionSet.selections, depth + 1);
        } else if (sel.kind === 'InlineFragment' && sel.selectionSet) {
          visitSelections(sel.selectionSet.selections, depth);
        }
        // FragmentSpread not followed — depth limit is a safety net, not exhaustive
      }
    };

    for (const def of doc.definitions) {
      if (
        (def.kind === 'OperationDefinition' || def.kind === 'FragmentDefinition') &&
        def.selectionSet
      ) {
        visitSelections(def.selectionSet.selections, 1);
      }
    }

    return exceeded ? `Query exceeds maximum depth of ${maxDepth}` : null;
  } catch {
    return null; // parse errors are handled by graphql() itself
  }
}

import type { Database } from '../../../../packages/engine/src/db/index.js';
import { MeiliSearchClient } from './providers/meilisearch.js';
import { TypesenseClient } from './providers/typesense.js';

let _db: Database | null = null;

function getMeiliClient(): MeiliSearchClient {
  return new MeiliSearchClient(
    process.env.MEILISEARCH_URL ?? 'http://localhost:7700',
    process.env.MEILISEARCH_API_KEY ?? '',
  );
}

function getTypesenseClient(): TypesenseClient {
  return new TypesenseClient(
    process.env.TYPESENSE_HOST ?? 'http://localhost',
    parseInt(process.env.TYPESENSE_PORT ?? '8108'),
    process.env.TYPESENSE_API_KEY ?? '',
  );
}

export const SearchManager = {
  init(db: Database): void {
    _db = db;
  },

  async search(
    collection: string,
    query: string,
    opts?: { limit?: number; filters?: string },
  ): Promise<any> {
    if (!_db) throw new Error('SearchManager not initialized');

    const indexConfig = await (_db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .where('collection', '=', collection)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (!indexConfig) {
      throw new Error(`No search index configured for collection "${collection}"`);
    }

    if (indexConfig.provider === 'meilisearch') {
      const client = getMeiliClient();
      return client.search(indexConfig.index_name, query, {
        limit: opts?.limit ?? 20,
        filter: opts?.filters,
      });
    } else {
      const client = getTypesenseClient();
      const queryBy = indexConfig.searchable_fields?.join(',') || 'id';
      return client.search(indexConfig.index_name, query, {
        query_by: queryBy,
        per_page: opts?.limit ?? 20,
        filter_by: opts?.filters,
      });
    }
  },

  async index(collection: string, record: Record<string, unknown>): Promise<void> {
    if (!_db) return;

    const indexConfig = await (_db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .where('collection', '=', collection)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (!indexConfig) return;

    if (indexConfig.provider === 'meilisearch') {
      const client = getMeiliClient();
      await client.addDocuments(indexConfig.index_name, [record]);
    } else {
      const client = getTypesenseClient();
      await client.upsertDocument(indexConfig.index_name, record);
    }
  },

  async remove(collection: string, id: string): Promise<void> {
    if (!_db) return;

    const indexConfig = await (_db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .where('collection', '=', collection)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (!indexConfig) return;

    if (indexConfig.provider === 'meilisearch') {
      const client = getMeiliClient();
      await client.deleteDocument(indexConfig.index_name, id);
    } else {
      const client = getTypesenseClient();
      await client.deleteDocument(indexConfig.index_name, id);
    }
  },

  async sync(collection: string): Promise<{ indexed: number }> {
    if (!_db) throw new Error('SearchManager not initialized');
    const db = _db;

    const indexConfig = await (db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .where('collection', '=', collection)
      .executeTakeFirst();

    if (!indexConfig) throw new Error(`No search index configured for collection "${collection}"`);

    // Read all records in batches of 100
    let offset = 0;
    let total = 0;
    const BATCH = 100;

    while (true) {
      let records: any[];
      try {
        records = await (db as any)
          .selectFrom(collection)
          .selectAll()
          .limit(BATCH)
          .offset(offset)
          .execute();
      } catch {
        // Table might not exist
        break;
      }

      if (records.length === 0) break;

      if (indexConfig.provider === 'meilisearch') {
        const client = getMeiliClient();
        await client.addDocuments(indexConfig.index_name, records);
      } else {
        const client = getTypesenseClient();
        for (const record of records) {
          await client.upsertDocument(indexConfig.index_name, record);
        }
      }

      total += records.length;
      offset += BATCH;
      if (records.length < BATCH) break;
    }

    // Update last_synced_at and record_count
    await (db as any)
      .updateTable('zv_search_indexes')
      .set({ last_synced_at: new Date(), record_count: total })
      .where('collection', '=', collection)
      .execute();

    return { indexed: total };
  },
};

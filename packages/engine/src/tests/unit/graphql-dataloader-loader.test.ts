/**
 * GraphQL DataLoader registry (lib/graphql-dataloader.ts) — batches id lookups
 * into one IN query and preserves key order (null for missing ids). Uses CannedDb
 * so no live Postgres is needed.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { createCollectionLoader, DataLoaderRegistry } from '../../lib/graphql-dataloader.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('createCollectionLoader', () => {
  it('returns rows in key order, null for missing ids', async () => {
    const canned = new CannedDb();
    canned.when(/from "contacts"/i, [
      { id: 'b', name: 'Bob' },
      { id: 'a', name: 'Ann' },
    ]);
    const load = createCollectionLoader(canned.kysely as unknown as Database, 'contacts');
    const rows = await load(['a', 'missing', 'b']);
    expect(rows).toEqual([{ id: 'a', name: 'Ann' }, null, { id: 'b', name: 'Bob' }]);
  });

  it('returns all nulls when the query fails', async () => {
    const canned = new CannedDb();
    canned.fail(/from "contacts"/i, new Error('db down'));
    const load = createCollectionLoader(canned.kysely as unknown as Database, 'contacts');
    const rows = await load(['1', '2']);
    expect(rows).toEqual([null, null]);
  });

  it('honors a custom key field', async () => {
    const canned = new CannedDb();
    canned.when(/from "tags"/i, [{ slug: 'vip', label: 'VIP' }]);
    const load = createCollectionLoader(canned.kysely as unknown as Database, 'tags', 'slug');
    expect(await load(['vip', 'other'])).toEqual([{ slug: 'vip', label: 'VIP' }, null]);
  });
});

describe('DataLoaderRegistry', () => {
  it('caches one loader per table name', async () => {
    const canned = new CannedDb();
    canned.when(/from "items"/i, [{ id: '1', v: 1 }]);
    const reg = new DataLoaderRegistry(canned.kysely as unknown as Database);
    const a = reg.get('items');
    const b = reg.get('items');
    expect(a).toBe(b);
    expect(await a(['1'])).toEqual([{ id: '1', v: 1 }]);
    expect(canned.log.filter((q) => /from "items"/i.test(q.sql)).length).toBe(1);
  });
});

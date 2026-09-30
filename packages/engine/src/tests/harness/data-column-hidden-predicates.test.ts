/**
 * A hidden column cannot be read through a predicate.
 *
 * Column permissions masked the RESPONSE and nothing else: the list path
 * validated filter and sort fields against the collection's schema, not against
 * what the caller may read, and `?search=` matched the stored `search_vector`,
 * which covers every text field. Measured against a `member` with can_read=false
 * on `secret`='classified':
 *
 *   ?filter={"secret":{"like":"class%"}}  1 record    {"like":"x%"}  0
 *   ?search=classified                    1 record    ?search=zebra  0
 *   ?sort=secret                          accepted (an ordering oracle)
 *
 * so the value came back one character at a time. The same held on a virtual
 * collection (filters, sort and search forwarded upstream) and on the SSE
 * stream (`?filter=` checked against the unmasked record).
 *
 * A filter or sort on a hidden column answers exactly as one on a column that
 * does not exist, so the refusal does not reveal the column either.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { _sseConnectionsForTests, broadcastDataEvent } from '../../routes/realtime.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hidpred_${STAMP}`;
const VIRTUAL = `hidpredv_${STAMP}`;

d('hidden columns cannot be read through filter, sort or search (in-process)', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const god = await createGodSession(app, db);
    member = await createMemberSession(app, db, {
      grants: [
        { collection: COLLECTION, actions: ['read'] },
        { collection: VIRTUAL, actions: ['read'] },
      ],
    });
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title: 'visible', secret: 'classified' }),
    });
    expect(create.status).toBe(201);

    await db
      .insertInto('zvd_collections')
      .values({
        name: VIRTUAL,
        display_name: VIRTUAL,
        icon: 'Table',
        route_group: 'private',
        is_permissioned: true,
        is_managed: true,
        is_system: false,
        schema_locked: false,
        sort: 99,
        singular_name: VIRTUAL,
        source_type: 'virtual',
        virtual_config: toJsonb({
          source_url: 'https://example.com/hidden-predicates',
          auth_type: 'none',
          list_path: '$.items',
          id_field: 'id',
        }),
        fields: toJsonb([
          { name: 'title', type: 'text', required: false, unique: false, indexed: false },
          { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
        ]),
      })
      .execute();
    DDLManager.invalidateCache(VIRTUAL);

    for (const collection_name of [COLLECTION, VIRTUAL]) {
      await db
        .insertInto('zvd_column_permissions')
        .values({
          collection_name,
          column_name: 'secret',
          role: '*',
          can_read: false,
          can_write: false,
        })
        .execute();
      await invalidateColumnPermCache(collection_name);
    }
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const r of readers.splice(0)) await r.cancel().catch(() => {});
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', 'in', [COLLECTION, VIRTUAL])
      .execute()
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', VIRTUAL)
      .execute()
      .catch(() => {});
    DDLManager.invalidateCache(VIRTUAL);
  });

  const list = async (collection: string, qs: string) => {
    const res = await app.request(`/api/data/${collection}?${qs}`, {
      headers: { cookie: member.cookie },
    });
    const body = (await res.json()) as { error?: string; records?: unknown[] };
    return { status: res.status, error: body.error, count: body.records?.length };
  };
  const json = (o: unknown) => `filter=${encodeURIComponent(JSON.stringify(o))}`;

  /** The answer for `field` must be the answer for a field that does not exist. */
  async function sameAsUnknown(collection: string, qs: (field: string) => string) {
    const hidden = await list(collection, qs('secret'));
    const unknown = await list(collection, qs('nosuchcol'));
    expect(hidden.status).toBe(400);
    expect(hidden.error?.replace('secret', 'F')).toBe(unknown.error?.replace('nosuchcol', 'F'));
    expect(unknown.status).toBe(400);
  }

  it('JSON filter on a hidden column is refused like an unknown column', async () => {
    await sameAsUnknown(COLLECTION, (f) => json({ [f]: { like: 'class%' } }));
    await sameAsUnknown(COLLECTION, (f) => json({ [f]: 'classified' }));
    // Cursor pagination parses the same filters.
    const cursor = Buffer.from(
      JSON.stringify({ id: crypto.randomUUID(), val: '2100-01-01' }),
    ).toString('base64url');
    await sameAsUnknown(COLLECTION, (f) => `${json({ [f]: { like: 'class%' } })}&cursor=${cursor}`);
  });

  it('bracket filter on a hidden column does not change the result', async () => {
    const hit = await list(COLLECTION, 'secret[like]=class%25');
    const miss = await list(COLLECTION, 'secret[like]=zebra%25');
    expect(hit.status).toBe(200);
    expect(hit.count).toBe(miss.count);
  });

  it('sort on a hidden column is refused like an unknown column, offset and cursor', async () => {
    await sameAsUnknown(COLLECTION, (f) => `sort=${f}`);
    const cursor = Buffer.from(JSON.stringify({ id: crypto.randomUUID(), val: 'm' })).toString(
      'base64url',
    );
    await sameAsUnknown(COLLECTION, (f) => `sort=${f}&cursor=${cursor}`);
  });

  it('a cursor cannot compare its value with a hidden default sort column', async () => {
    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'created_at',
        role: '*',
        can_read: false,
        can_write: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await invalidateColumnPermCache(COLLECTION);
    try {
      const at = (val: string) =>
        Buffer.from(JSON.stringify({ id: crypto.randomUUID(), val })).toString('base64url');
      const future = await list(COLLECTION, `cursor=${at('2100-01-01')}`);
      const past = await list(COLLECTION, `cursor=${at('2000-01-01')}`);
      // Sorted by `id` now, so a date is not even a valid cursor value — and the
      // two answers are still the same.
      expect(past.status).toBe(future.status);
      expect(past.count).toBe(future.count);
    } finally {
      await db.deleteFrom('zvd_column_permissions').where('id', '=', perm.id).execute();
      await invalidateColumnPermCache(COLLECTION);
    }
  });

  it('the default order does not rank rows by a hidden created_at', async () => {
    const table = DDLManager.getTableName(COLLECTION);
    const god = await createGodSession(app, db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({ title: `order-${i}` }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: string }).id);
    }
    // The smallest id is the newest row, so creation order and id order disagree.
    ids.sort();
    for (const [i, id] of ids.entries()) {
      await db
        .updateTable(table as never)
        .set({ created_at: new Date(Date.UTC(2003 - i, 0, 1)) } as never)
        .where('id' as never, '=', id as never)
        .execute();
    }
    const order = async () => {
      const res = await app.request(
        `/api/data/${COLLECTION}?${json({ title: { like: 'order-%' } })}`,
        { headers: { cookie: member.cookie } },
      );
      return ((await res.json()) as { records: { id: string }[] }).records.map((r) => r.id);
    };
    expect(await order()).toEqual(ids); // newest first while created_at is readable
    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'created_at',
        role: '*',
        can_read: false,
        can_write: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await invalidateColumnPermCache(COLLECTION);
    try {
      expect(await order()).toEqual([...ids].reverse()); // by id once it is hidden
    } finally {
      await db.deleteFrom('zvd_column_permissions').where('id', '=', perm.id).execute();
      await invalidateColumnPermCache(COLLECTION);
      await db
        .deleteFrom(table as never)
        .where('id' as never, 'in', ids as never)
        .execute();
    }
  });

  it('search does not match a hidden column, and still matches a visible one', async () => {
    expect((await list(COLLECTION, 'search=classified')).count).toBe(0);
    expect((await list(COLLECTION, 'search=classif')).count).toBe(0); // the trigram half
    expect((await list(COLLECTION, 'search=visible')).count).toBe(1);
  });

  it('virtual: a hidden column is never forwarded upstream as a filter, sort or search', async () => {
    const upstream: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      upstream.push(String(url));
      return new Response(JSON.stringify({ items: [{ id: 'v1', title: 't', secret: 's' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    for (const qs of [json({ secret: { like: 'class%' } }), 'sort=secret', 'search=classified']) {
      const res = await list(VIRTUAL, qs);
      expect(res.status).toBe(400);
    }
    expect(upstream.filter((u) => /secret|classified/.test(u))).toEqual([]);
    // A visible column still goes through.
    expect((await list(VIRTUAL, json({ title: 't' }))).status).toBe(200);
  });

  it('SSE: ?filter= on a hidden column matches nothing, whatever its value', async () => {
    async function delivered(filter: unknown) {
      const res = await app.request(
        `/api/realtime/stream?collection=${COLLECTION}&${json(filter)}`,
        { headers: { cookie: member.cookie } },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      readers.push(reader);
      await reader.read(); // `connected`
      const sub = [..._sseConnectionsForTests().get(member.userId)!].at(-1)!;
      const got: string[] = [];
      sub.stream.writeSSE = (async (m: { data: string }) => {
        got.push(m.data);
      }) as never;
      broadcastDataEvent(
        COLLECTION,
        'insert',
        { id: 'x', title: 'visible', secret: 'classified' },
        sub.tenantId,
      );
      await Bun.sleep(30);
      return got.length;
    }
    expect(await delivered({ secret: 'classified' })).toBe(await delivered({ secret: 'zebra' }));
    expect(await delivered({ title: 'visible' })).toBe(1);
  });
});

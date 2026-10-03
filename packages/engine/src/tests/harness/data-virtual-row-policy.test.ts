/**
 * Row policies reach virtual collections.
 *
 * A virtual collection's rows come from an upstream API, so the policy cannot
 * be a WHERE. The list and single handlers applied column permissions and
 * nothing else: a row its policy hides was served whole. They now run the
 * row gates in memory (`scope.admits`), as `?as_of=` does.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvrow_${Date.now()}`;
const UPSTREAM = [
  { id: '00000000-0000-4000-8000-000000000001', title: 'shown', bucket: 'open' },
  { id: '00000000-0000-4000-8000-000000000002', title: 'hidden', bucket: 'closed' },
];

d('virtual collection row policies (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let policyId = '';
  const originalFetch = globalThis.fetch;

  const upstream = (body: unknown) => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    ({ cookie: memberCookie } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    }));
    await db
      .insertInto('zvd_collections')
      .values({
        name: COLLECTION,
        display_name: COLLECTION,
        icon: 'Table',
        route_group: 'private',
        is_permissioned: true,
        is_managed: true,
        is_system: false,
        schema_locked: false,
        sort: 99,
        singular_name: COLLECTION,
        source_type: 'virtual',
        virtual_config: toJsonb({
          source_url: 'https://example.com/virtual-api',
          auth_type: 'none',
          field_mapping: {},
          list_path: '$.items',
          id_field: 'id',
        }),
        fields: toJsonb([
          { name: 'title', type: 'text', required: false, unique: false, indexed: false },
          { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
        ]),
      })
      .execute();
    DDLManager.invalidateCache(COLLECTION);

    const policy = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
      }),
    });
    expect(policy.status).toBe(201);
    policyId = ((await policy.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    if (!db) return;
    if (policyId) await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`.execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
    DDLManager.invalidateCache(COLLECTION);
    await invalidateRlsCache(COLLECTION);
  });

  it('the list leaves out a row its policy hides, and does not report the upstream total', async () => {
    upstream({ items: UPSTREAM, total: 2 });
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie: memberCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { title: string }[];
      pagination: { total: number };
    };
    expect(body.records.map((r) => r.title)).toEqual(['shown']);
    expect(body.pagination.total).toBe(-1);
  });

  it('a page with nothing hidden still does not report the upstream total', async () => {
    // The total counts rows on other pages the policy hides.
    upstream({ items: [UPSTREAM[0]], total: 2 });
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie: memberCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { title: string }[];
      pagination: { total: number; pages: number };
    };
    expect(body.records.map((r) => r.title)).toEqual(['shown']);
    expect(body.pagination).toMatchObject({ total: -1, pages: -1 });
  });

  it('a single GET of a hidden row is not found', async () => {
    upstream(UPSTREAM[1]);
    const res = await app.request(`/api/data/${COLLECTION}/${UPSTREAM[1]!.id}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(404);
  });

  it('a single GET of a visible row is served', async () => {
    upstream(UPSTREAM[0]);
    const res = await app.request(`/api/data/${COLLECTION}/${UPSTREAM[0]!.id}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
  });
});

/**
 * `POST /api/saved-queries/execute` reads through the read gate.
 *
 * It applied column permissions and nothing else, so a saved query listed the
 * rows an extension's query alter or an entity-access rule hides from
 * `GET /api/data`. The entity check judges the whole record, including columns
 * the query did not ask for — and the answer must still carry only those it
 * did.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, queryAlterRegistry } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsqgate_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const OWNER = 'harness-saved-query-gate';

d('saved-query execute honours the read gate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const execute = async () => {
    const res = await app.request('/api/saved-queries/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection: COLLECTION,
        config: {
          filters: [],
          filter_mode: 'AND',
          filter_groups: [],
          columns: ['title'],
          sorts: [{ field: 'title', direction: 'asc' }],
          limit: 20,
          page: 1,
        },
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { records: Array<Record<string, unknown>> }).records;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner_tag', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (const [title, owner_tag] of [
      ['alpha', 'mine'],
      ['beta', 'theirs'],
    ]) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title, owner_tag }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterEach(() => {
    queryAlterRegistry.unregisterAll(OWNER);
    entityAccessRegistry.unregisterAll(OWNER);
  });

  afterAll(async () => {
    queryAlterRegistry.unregisterAll(OWNER);
    entityAccessRegistry.unregisterAll(OWNER);
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('returns only the asked-for columns', async () => {
    const records = await execute();
    expect(records.map((r) => r.title)).toEqual(['alpha', 'beta']);
    for (const r of records) expect(Object.keys(r).sort()).toEqual(['id', 'title']);
  });

  it('does not list rows an extension query alter hides', async () => {
    queryAlterRegistry.registerAs(OWNER, TABLE, (qb: any) => qb.where('title', '<>', 'beta'));
    expect((await execute()).map((r) => r.title)).toEqual(['alpha']);
  });

  it('does not list rows entity access denies, judged on columns not asked for', async () => {
    entityAccessRegistry.registerAs(OWNER, TABLE, (r: { owner_tag?: string }) =>
      r.owner_tag === 'mine' ? 'allow' : 'deny',
    );
    const records = await execute();
    expect(records.map((r) => r.title)).toEqual(['alpha']);
    expect(records[0]).not.toHaveProperty('owner_tag');
  });
});

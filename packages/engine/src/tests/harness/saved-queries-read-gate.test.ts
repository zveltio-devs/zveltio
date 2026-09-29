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
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsqgate_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const OWNER = 'harness-saved-query-gate';

d('saved-query execute honours the read gate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const execute = async (as = cookie, columns = ['title']) => {
    const res = await app.request('/api/saved-queries/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: as },
      body: JSON.stringify({
        collection: COLLECTION,
        config: {
          filters: [],
          filter_mode: 'AND',
          filter_groups: [],
          columns,
          sorts: [{ field: 'title', direction: 'asc' }],
          limit: 20,
          page: 1,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<Record<string, unknown>>;
      pagination: { total: number };
    };
    return Object.assign(body.records, { total: body.pagination.total });
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
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await invalidateRlsCache(COLLECTION).catch(() => {});
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

  it('does not list rows a row policy hides from a member, and counts only what it lists', async () => {
    // Checked last: the policy stays until afterAll. A god reads past row
    // policies (`data:view_all`), so the reader is a member.
    const member = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'owner_tag',
        filter_op: 'eq',
        filter_value_source: 'static:mine',
        description: 'saved-query read gate',
      }),
    });
    expect(res.status).toBeLessThan(300);
    await invalidateRlsCache(COLLECTION);

    // No columns asked: every allowed column, and still only the admitted row.
    const records = await execute(member.cookie, []);
    expect(records.map((r) => r.title)).toEqual(['alpha']);
    expect(records.total).toBe(1);
    expect(records[0]).not.toHaveProperty('search_text');
    expect(records[0]).not.toHaveProperty('search_vector');
    // The god, past the policy, still reads both: the policy is what hid `beta`.
    expect((await execute()).map((r) => r.title)).toEqual(['alpha', 'beta']);
  });
});

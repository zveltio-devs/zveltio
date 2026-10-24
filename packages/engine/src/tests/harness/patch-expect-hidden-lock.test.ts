/**
 * A PATCH with `expect` answers 404 for a row a query alter hides without
 * waiting on another writer's lock on that row.
 *
 * `patchRecord` (an extension's `collections.update` with `expect`) used to take `SELECT … FOR UPDATE` by id before the before-row
 * read that applies the alters, so a caller probing a guessed id blocked while
 * someone else held the row: the wait told them the hidden row exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dataApiWriteDetached } from '../../lib/data/api-write.js';
import type { RequestUser } from '../../lib/data/types.js';
import { queryAlterRegistry } from '../../lib/data/query-alter.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hqaexpect_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const ALTER_OWNER = 'harness-patch-expect-lock';

d('PATCH expect on a hidden row (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const ids: Record<string, string> = {};

  let user: RequestUser;
  // `expect` reaches the data API through the extension host alone.
  const patch = (id: string, label: string, expected: string) =>
    dataApiWriteDetached('update', db, {
      collection: COLLECTION,
      id,
      body: async () => ({ label }),
      user,
      authType: 'session',
      trx: undefined,
      tenantId: null,
      expect: { label: [expected] },
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const session = await app.request('/api/auth/get-session', { headers: { cookie } });
    user = ((await session.json()) as { user: RequestUser }).user;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    for (const label of ['keep-me', 'hide-me']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label }),
      });
      expect(res.status).toBe(201);
      ids[label] = ((await res.json()) as { id: string }).id;
    }
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, (qb, _user) =>
      qb.where('label', '=', 'keep-me'),
    );
  }, 60_000);

  afterAll(async () => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
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

  it('answers 404 while another transaction holds the hidden row', async () => {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.transaction().execute(async (trx) => {
      await sql`SELECT 1 FROM ${sql.table(TABLE)} WHERE id = ${ids['hide-me']} FOR UPDATE`.execute(
        trx,
      );
      locked();
      await new Promise<void>((r) => (release = r));
    });
    await held;
    try {
      const res = await Promise.race([
        patch(ids['hide-me']!, 'probe', 'hide-me'),
        Bun.sleep(3_000).then(() => 'blocked' as const),
      ]);
      expect(res === 'blocked' ? res : res.status).toBe(404);
    } finally {
      release();
      await holder;
    }
  }, 20_000);

  it('still tests the precondition on a visible row', async () => {
    const stale = await patch(ids['keep-me']!, 'keep-me', 'other');
    expect(stale.status).toBe(409);
    const res = await patch(ids['keep-me']!, 'keep-me', 'keep-me');
    expect(res.status).toBe(200);
  });
});

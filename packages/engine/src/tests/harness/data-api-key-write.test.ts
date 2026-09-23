/**
 * An API key could not write.
 *
 * Two defects stacked on the same request:
 *
 *   1. `afterWrite` recorded the revision under `user.id`, which for a key is
 *      `apikey:<uuid>`. `zv_revisions.user_id` is a foreign key into `user`, so
 *      the insert failed with 23503; its `.catch` swallowed the error but not
 *      its effect — the request transaction was aborted, the next statement
 *      died with 25P02, and every key-authenticated create answered 500 after
 *      the row had been written.
 *   2. The Studio's key form offered `write`, an action `checkAccess` never
 *      asks for, so a key made there was refused 403 before it got that far.
 *
 * The existing API-key suite only reads, which is why neither showed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hapikeyw_${Date.now()}`;

d('data API-key writes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const keyIds: string[] = [];

  async function makeKey(actions: string[]): Promise<string> {
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness write key ${actions.join('+')} ${Date.now()}`,
        scopes: [{ collection: COLLECTION, actions }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; key: string };
    keyIds.push(body.id);
    return body.key;
  }

  const post = (key: string, title: string) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ title }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of keyIds) {
      await db
        .deleteFrom('zv_api_key_access_log')
        .where('api_key_id', '=', id)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zv_api_keys')
        .where('id', '=', id)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('creates a record, and records the revision under the key issuer', async () => {
    const key = await makeKey(['read', 'create']);
    const res = await post(key, 'by key');
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data?: { id: string }; id?: string }).data ?? {
      id: '',
    };

    const rev = await db
      .selectFrom('zv_revisions')
      .select(['user_id', 'record_id'])
      .where('collection', '=', COLLECTION)
      .where('action', '=', 'create')
      .executeTakeFirst();
    expect(rev, 'no revision row was written').toBeDefined();
    if (id) expect(rev?.record_id).toBe(id);
    const issuer = await db
      .selectFrom('zv_api_keys')
      .select('created_by')
      .where('id', '=', keyIds[0] as string)
      .executeTakeFirst();
    expect(rev?.user_id).toBe(issuer?.created_by ?? null);
  });

  it('honours a key stored with the Studio form’s old `write` action', async () => {
    const key = await makeKey(['read', 'write']);
    expect((await post(key, 'legacy write')).status).toBe(201);
  });

  it('a read-only key is still refused', async () => {
    const key = await makeKey(['read']);
    expect((await post(key, 'nope')).status).toBe(403);
  });
});

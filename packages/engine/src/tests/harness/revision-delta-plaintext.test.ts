/**
 * The revision log does not keep the plaintext of an encrypted field.
 *
 * `patchRecord` records `delta: body` -- the raw request body, read before
 * `processInput` runs. That is the one copy of the write that has not been
 * through `maybeEncrypt`, so for a field declared `encrypted: true` the row goes
 * to disk as `enc:v1:...` and `zv_revisions.delta` keeps what it was encrypted
 * from, in the clear, for every PATCH, forever.
 *
 * `data` (the written row) is already correct; only `delta` is not. And `delta`
 * is what the audit UI shows as "what changed".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const COLLECTION = `hrevdelta_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const SECRET = 'iban-RO49-AAAA-1B31-0075-9384-0000';

d('revision delta and encrypted fields (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: false, unique: false, indexed: false },
        {
          name: 'secret',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);

    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    const made = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'a' }),
    });
    expect(made.status).toBe(201);
    recordId = ((await made.json()) as { id: string }).id;

    const patched = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(patched.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
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
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('stores the column encrypted, which is the premise', async () => {
    const row = await sql<{ secret: string }>`
      SELECT secret FROM ${sql.table(TABLE)} WHERE id = ${recordId}::uuid
    `.execute(db);
    expect(row.rows[0]!.secret.startsWith('enc:v1:')).toBe(true);
  });

  it('does not keep the plaintext in the revision delta', async () => {
    const rev = await db
      .selectFrom('zv_revisions')
      .select(['data', 'delta'])
      .where('collection', '=', COLLECTION)
      .where('record_id', '=', recordId)
      .where('action', '=', 'update')
      .executeTakeFirstOrThrow();

    expect(JSON.stringify(rev.data)).not.toContain(SECRET);
    expect(JSON.stringify(rev.delta ?? {})).not.toContain(SECRET);
  });
});

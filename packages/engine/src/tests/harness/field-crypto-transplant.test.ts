/**
 * A client cannot plant field ciphertext and read its plaintext back (A14).
 *
 * `enc:v1:` carries no binding to tenant, collection, field or record, and the
 * key is instance-wide. `maybeEncrypt` stored any client string that already
 * started with `enc:v1:` as given ("already encrypted"), and every read path
 * decrypts it. So one ciphertext from anywhere (another tenant's row, a revision,
 * a log, or the raw value `maybeDecrypt` returns when it cannot open one) became
 * plaintext by writing it into a record the caller owns and reading it back.
 *
 * The write path now refuses a client value carrying the envelope. The revert of
 * a revision still restores an encrypted field: it sends the decrypted value,
 * which the PATCH seals again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, decryptField, encryptField } from '../../lib/data/index.js';
import {
  asDefaultTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const COLLECTION = `hftransplant_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const SECRET = 'iban-RO49-AAAA-1B31-0075-9384-0000';

d('field ciphertext transplant (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  // Ciphertext of SECRET as it would leak from elsewhere.
  let stolen = '';

  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const stored = async (id: string) =>
    (
      await asDefaultTenant(
        db,
        sql<{
          secret: string | null;
        }>`SELECT secret FROM ${sql.table(TABLE)} WHERE id = ${id}::uuid`,
      )
    ).rows[0]?.secret ?? null;

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
         WHERE table_schema = 'public' AND table_name = ${TABLE}`.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }
    stolen = await encryptField(SECRET);
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
    await asDefaultTenant(db, (t) =>
      t.deleteFrom('zv_revisions').where('collection', '=', COLLECTION).execute(),
    ).catch(() => {});
  });

  it('POST refuses a value that is already field ciphertext', async () => {
    const res = await req('POST', `/api/data/${COLLECTION}`, { label: 'x', secret: stolen });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(SECRET);
    expect(res.status).toBe(422);
  });

  it('PATCH and PUT refuse it too', async () => {
    const made = await req('POST', `/api/data/${COLLECTION}`, { label: 'y', secret: 'mine' });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { id: string }).id;
    for (const method of ['PATCH', 'PUT']) {
      const res = await req(method, `/api/data/${COLLECTION}/${id}`, {
        label: 'y',
        secret: stolen,
      });
      expect(res.status).toBe(422);
    }
    expect(await stored(id)).not.toBe(stolen);
    const read = (await (await req('GET', `/api/data/${COLLECTION}/${id}`)).json()) as {
      data?: { secret?: string };
      secret?: string;
    };
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it('bulk create refuses it', async () => {
    const res = await req('POST', `/api/data/${COLLECTION}/bulk`, {
      records: [{ label: 'z', secret: stolen }],
    });
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    expect(res.status).toBe(422);
  });

  it('a webhook refuses it as its signing secret', async () => {
    const res = await req('POST', '/api/webhooks', {
      name: 'transplant',
      url: 'https://example.com/hook',
      events: ['insert'],
      secret: stolen,
    });
    expect(res.status).toBe(400);
  });

  it('a plain value is sealed, and a revision revert restores it', async () => {
    const made = await req('POST', `/api/data/${COLLECTION}`, { label: 'r', secret: 'first' });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { id: string }).id;
    expect((await stored(id))?.startsWith('enc:v1:')).toBe(true);
    expect((await req('PATCH', `/api/data/${COLLECTION}/${id}`, { secret: 'second' })).status).toBe(
      200,
    );

    const revs = (await (
      await req('GET', `/api/revisions?collection=${COLLECTION}&record_id=${id}&action=create`)
    ).json()) as { revisions?: Array<{ id: string }>; data?: Array<{ id: string }> };
    const rev = (revs.revisions ?? revs.data ?? [])[0];
    expect(rev).toBeDefined();
    const reverted = await req('POST', `/api/revisions/${rev!.id}/revert`);
    expect(reverted.status).toBe(200);
    const back = await stored(id);
    expect(back?.startsWith('enc:v1:')).toBe(true);
    expect(await decryptField(back!)).toBe('first');
  });
});

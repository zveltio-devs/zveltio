/**
 * Import must encrypt the fields marked `encrypted: true`.
 *
 * Import writes straight to the table instead of going through the write
 * pipeline, so it never called `maybeEncrypt`. The same value stored through
 * the API was encrypted; the same value arriving by CSV was written in
 * PLAINTEXT. Nothing looked wrong — the field still reads as encrypted
 * everywhere in the UI, and only the bytes on disk differ — and importing is
 * the BULK path, so it is the one most likely to carry the sensitive column.
 *
 * Asserted against a real database and the real column contents, because the
 * whole bug is that everything above the storage layer looked correct.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcrypt_${Date.now()}`;
const SECRET = 'sk_live_do_not_store_me_in_plaintext';

d('import encrypts encrypted fields', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: false, unique: false, indexed: false },
        {
          name: 'api_key',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_import_logs WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
  });

  it('stores ciphertext, not the value from the CSV', async () => {
    const fd = new FormData();
    fd.set('format', 'csv');
    fd.set(
      'file',
      new File([`label,api_key\nstripe,${SECRET}\n`], 'keys.csv', { type: 'text/csv' }),
    );
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(200);

    const rows = (await sql.raw(`SELECT label, api_key FROM "zvd_${COLLECTION}"`).execute(db)) as {
      rows: { label: string; api_key: string }[];
    };
    expect(rows.rows.length).toBe(1);

    const stored = rows.rows[0]!.api_key;
    // The bug, stated directly: this used to be the plaintext secret.
    expect(stored).not.toBe(SECRET);
    expect(stored).not.toContain('do_not_store_me');
    expect(stored.startsWith('enc:v1:')).toBe(true);

    // A field NOT marked encrypted must stay readable — encrypting everything
    // would break every query and index on ordinary columns.
    expect(rows.rows[0]!.label).toBe('stripe');
  });
});

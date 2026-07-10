/**
 * Phase C — per-field encryption at rest, driven through the in-process app.
 *
 * Regression for a real bug: field-crypto captured FIELD_ENCRYPTION_KEY at module
 * load, so when the module was pulled in (via the route/write-pipeline import
 * chain) before the key was set, encryption was silently disabled and
 * `encrypted: true` fields were written in PLAINTEXT. field-crypto now reads the
 * key lazily. This suite proves the full path: write an encrypted field through
 * the API → the raw column holds ciphertext (enc:v1:…), never the plaintext →
 * reading back through the API returns the decrypted value.
 *
 * Also covers field-crypto encrypt/decrypt + the write-pipeline encrypt branch +
 * the shape decrypt branch end-to-end.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLLECTION = `henc_${Date.now()}`;
const SECRET = `top-secret-${Math.floor(Math.random() * 1e9)}`;

d('per-field encryption at rest (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
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
  });

  afterAll(async () => {
    if (db) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  it('writes an encrypted field and stores CIPHERTEXT at rest', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'row', secret: SECRET }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { id?: string; data?: { id: string } };
    recordId = (body.data ?? (body as { id: string })).id;
    expect(recordId).toBeDefined();

    // Read the raw column directly — it must be encrypted, never the plaintext.
    const raw = await sql<{ secret: string | null }>`
      SELECT secret FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE id = ${recordId}
    `.execute(db);
    const stored = raw.rows[0]?.secret ?? '';
    expect(stored).toStartWith('enc:v1:');
    expect(stored).not.toContain(SECRET);
  });

  it('reads the encrypted field back as decrypted plaintext via the API', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { secret: string }; secret?: string };
    expect((body.data ?? body).secret).toBe(SECRET);
  });
});

/**
 * Validation rules judge the plaintext of a `secret` (ADR 0024) and of an
 * `encrypted` field. They used to see the ciphertext `processInput` had already
 * produced, so `minLength: 32` on such a field passed a one-character value, the ciphertext being longer, and
 * `pattern: '^[a-z]+$'` refused every value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRulesCache } from '../../lib/validation-engine.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hencval_${Date.now()}`;

d('validation rules on an encrypted field', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const post = (body: unknown) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'key', type: 'secret', required: false, unique: false, indexed: false },
        {
          name: 'note',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
    await sql`
      INSERT INTO zv_validation_rules
        (collection, field_name, rule_type, rule_config, error_message, is_active)
      VALUES (${COLLECTION}, 'key', 'minLength', ${JSON.stringify({ value: 32 })}::jsonb,
              'Key too short', TRUE),
             (${COLLECTION}, 'key', 'pattern', ${JSON.stringify({ pattern: '^[a-z]+$' })}::jsonb,
              'Key must be lowercase letters', TRUE),
             (${COLLECTION}, 'note', 'minLength', ${JSON.stringify({ value: 32 })}::jsonb,
              'Note too short', TRUE)
    `.execute(db);
    invalidateRulesCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  it('refuses a short value, which its ciphertext would have hidden', async () => {
    const res = await post({ key: 'abc' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('Key too short');
  });

  it('judges a pattern on the plaintext', async () => {
    expect((await post({ key: 'A'.repeat(40) })).status).toBe(422);
  });

  it('judges an encrypted text field on its plaintext too', async () => {
    const res = await post({ key: 'a'.repeat(40), note: 'n' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('Note too short');
  });

  it('stores a value that passes, encrypted', async () => {
    expect((await post({ key: 'a'.repeat(40) })).status).toBe(201);
    const row = (
      await sql<{ key: string }>`SELECT key FROM ${sql.table(`zvd_${COLLECTION}`)}`.execute(db)
    ).rows[0];
    expect(row?.key).not.toBe('a'.repeat(40));
  });
});

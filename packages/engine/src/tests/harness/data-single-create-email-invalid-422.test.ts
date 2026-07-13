/**
 * Phase C — POST rejects invalid email field values (handlers/single + processInput).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hemailc_${Date.now()}`;

d('data single create email validation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'name', type: 'text', required: true, unique: false, indexed: false },
        { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
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

  it('returns 422 when contact is not a valid email on POST', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Ada', contact: 'not-an-email' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: string[]; detail?: string; error?: string };
    const msg = JSON.stringify(body.errors ?? body.detail ?? body.error ?? '');
    expect(msg.toLowerCase()).toMatch(/email|invalid|contact/);
  });

  it('creates a row when contact is a valid email', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Bob', contact: 'bob@example.com' }),
    });
    expect(res.status).toBe(201);
  });
});

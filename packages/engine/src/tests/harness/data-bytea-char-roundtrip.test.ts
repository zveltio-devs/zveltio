/**
 * Through the data API, live: a `bytea` value is base64 both ways, and a value
 * too long for a `char` column answers 422, not 500 (ADR 0054 spike).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asDefaultTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbyc_${Date.now()}`;
const f = (name: string, type: string) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

d('bytea and char through the data API', () => {
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
      fields: [f('bin', 'bytea'), f('code', 'char')],
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

  it('a base64 bytea is stored as its bytes and read back as the same base64', async () => {
    const res = await post({ bin: 'AAH+/w==' });
    expect([200, 201]).toContain(res.status);
    const { id } = (await res.json()) as { id: string };
    const raw = await asDefaultTenant(
      db,
      sql<{ n: number }>`
      SELECT octet_length(bin) AS n FROM ${sql.table(`zvd_${COLLECTION}`)} WHERE id = ${id}
    `,
    );
    expect(Number(raw.rows[0]?.n)).toBe(4);
    const read = await app.request(`/api/data/${COLLECTION}/${id}`, { headers: { cookie } });
    const body = (await read.json()) as { bin?: unknown; data?: { bin?: unknown } };
    expect(body.data?.bin ?? body.bin).toBe('AAH+/w==');
  });

  it('a value that is not base64 is refused before the database', async () => {
    expect((await post({ bin: 'not base64!' })).status).toBe(422);
  });

  it('a value too long for a char column answers 422', async () => {
    const res = await post({ code: 'too long' });
    expect(res.status).toBe(422);
  });
});

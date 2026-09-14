/**
 * A12 — a cursor that decodes to a JSON `null` must fall back to offset paging.
 *
 * `decodeCursor` documents that a malformed cursor returns null so the caller
 * falls back to the offset path, and every other malformed shape does. A cursor
 * whose payload is the JSON literal `null` parses successfully, so it never
 * reaches the `catch`, and the guard below it reads `.id` off `null` — a
 * TypeError out of a pure parsing function, which the route turns into a 500 on
 * input a client fully controls.
 *
 * Asserted at the HTTP boundary rather than on the helper, because the claim is
 * about what the endpoint answers, not about what the function returns.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcursnull_${Date.now()}`;

d('data list — malformed cursor falls back to offset (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    for (const label of ['a', 'b', 'c']) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label }),
      });
    }
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

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  // Every payload here parses as JSON but is not an object with an id, so all of
  // them are "malformed cursor" by the documented contract. `null` is the one
  // that survives `JSON.parse` and then fails the property read.
  const payloads: Array<[string, string]> = [
    ['null', 'null'],
    ['a JSON string', '"nope"'],
    ['a JSON number', '123'],
    ['a JSON array', '[]'],
    ['a JSON boolean', 'true'],
  ];

  for (const [name, raw] of payloads) {
    it(`answers 200 for a cursor holding ${name}`, async () => {
      const cursor = Buffer.from(raw).toString('base64url');
      const res = await list(`?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: unknown[] };
      expect(Array.isArray(body.records)).toBe(true);
      expect(body.records.length).toBeGreaterThan(0);
    });
  }
});

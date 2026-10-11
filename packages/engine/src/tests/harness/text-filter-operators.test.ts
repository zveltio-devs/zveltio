/**
 * The business text operators — contains, not_contains, starts_with, ends_with —
 * through the data API and saved queries, against a live database.
 *
 * Text field types advertised not_contains / starts_with / ends_with while the
 * data API skipped them (every row answered); saved queries ran them as a
 * case-sensitive LIKE with the caller's `%` and `_` as wildcards, and a malformed
 * `in` compared the column with its own name.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `htextops_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const LABELS = ['RO-100', 'ro-200', 'AB1', 'A_1', '50% off', 'report.pdf'];

d('text filter operators (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }
    for (const label of [...LABELS, null]) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label }),
      });
      expect(res.status).toBe(201);
    }
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
  });

  const viaApi = async (op: string, value: string) => {
    const qs = new URLSearchParams({ [`label[${op}]`]: value, limit: '100' });
    const res = await app.request(`/api/data/${COLLECTION}?${qs}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { label: string | null }[] };
    return body.records.map((r) => r.label).sort();
  };

  const viaSavedQuery = async (operator: string, value: unknown) => {
    const res = await app.request('/api/saved-queries/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection: COLLECTION,
        config: { filters: [{ field: 'label', operator, value }], limit: 100 },
      }),
    });
    return res;
  };
  const labels = async (res: Response) => {
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { label: string | null }[] };
    return body.records.map((r) => r.label).sort();
  };

  const expected: [string, string, (string | null)[]][] = [
    ['starts_with', 'ro-', ['RO-100', 'ro-200']],
    ['ends_with', '.PDF', ['report.pdf']],
    ['contains', 'a_1', ['A_1']],
    ['contains', '50%', ['50% off']],
    ['not_contains', 'ro-', ['50% off', 'A_1', 'AB1', 'report.pdf', null]],
  ];

  for (const [op, value, want] of expected) {
    it(`data API: label[${op}]=${value}`, async () => {
      expect(await viaApi(op, value)).toEqual(want.sort());
    });
    it(`saved query: ${op} ${value}`, async () => {
      expect(await labels(await viaSavedQuery(op, value))).toEqual(want.sort());
    });
  }

  it('saved query: a malformed in is refused, not compared with the column name', async () => {
    const res = await viaSavedQuery('in', 'label');
    expect(res.status).toBe(400);
  });

  it('saved query: the previewed URL uses the data API syntax', async () => {
    const res = await viaSavedQuery('starts_with', 'ro-');
    const body = (await res.json()) as { api_url: string };
    expect(body.api_url).toContain(`label%5Bstarts_with%5D=ro-`);
  });
});

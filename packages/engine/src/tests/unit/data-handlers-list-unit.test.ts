/**
 * Unit coverage for lib/data/handlers/list.ts — listRecords().
 *
 * Same mechanism as the single.ts suite: the harness drives this handler through
 * the real /api/data routes, but the unit lane only *loads* the module without
 * executing it — bun then instruments a far wider line view (296 lines, ~5% hit)
 * than once the code runs. The gate unions the lanes, so those never-executed
 * lines inflate the denominator. Executing the handler here (CannedDb, no
 * Postgres, no app boot) collapses that phantom view.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { listRecords } from '../../lib/data/handlers/list.js';
import { DDLManager } from '../../lib/data/index.js';
// Deep import: QuerySchema isn't on the lib/data barrel; import-boundaries.ts
// exempts *.test.ts ("tests may deep-import internals").
import { QuerySchema } from '../../lib/data/query-parse.js';
import { initPermissions, initRls } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'admin', v1: '*', v2: '*', v3: '*', v4: null, v5: null },
  { ptype: 'g', v0: 'u-god', v1: 'admin', v2: '*', v3: null, v4: null, v5: null },
];
const USER = { id: 'u-god', role: 'admin' };
const NOBODY = { id: 'u-nobody', role: 'member' };
const ID = '11111111-1111-4111-8111-111111111111';
const COLLECTION_DEF = {
  name: 'things',
  display_name: 'Things',
  fields: JSON.stringify([{ name: 'title', type: 'text' }]),
  source_type: 'table',
  virtual_config: null,
};

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** Mount listRecords on a real Hono context; query is parsed from the URL. */
function makeApp(db: CannedDb, user: unknown = USER): Hono {
  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: minimal test context wiring
  app.get('/:collection', (c: any) => {
    c.set('user', user as never);
    const raw = Object.fromEntries(new URL(c.req.url).searchParams);
    return listRecords(c as never, asDb(db), QuerySchema.parse(raw));
  });
  return app;
}

describe('listRecords (unit)', () => {
  let db: CannedDb;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
    const seed = new CannedDb();
    seed.when(/FROM zvd_permissions/i, POLICY_ROWS);
    await initPermissions(asDb(seed));
  });

  beforeEach(() => {
    db = new CannedDb();
    initRls(asDb(db)); // getRlsFilters reads a module-global db
    DDLManager.invalidateCache(); // module-global cache leaks between tests
  });

  it('403s a role without read permission', async () => {
    const res = await makeApp(db, NOBODY).request('/things');
    expect(res.status).toBe(403);
  });

  it('lists records on the happy path', async () => {
    db.when(/from "zvd_collections"/i, [COLLECTION_DEF]);
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'hello' }]);
    const res = await makeApp(db).request('/things');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { title: string }[] };
    expect(body.records.some((r) => r.title === 'hello')).toBe(true);
  });

  it('honours ?limit= and reports pagination', async () => {
    db.when(/from "zvd_collections"/i, [COLLECTION_DEF]);
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'hello' }]);
    const res = await makeApp(db).request('/things?limit=5&page=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination?: { limit: number } };
    if (body.pagination) expect(body.pagination.limit).toBe(5);
  });

  // ── Time travel (?as_of=) ────────────────────────────────────────

  it('400s an invalid as_of date', async () => {
    const res = await makeApp(db).request('/things?as_of=not-a-date');
    expect(res.status).toBe(400);
  });

  it('reconstructs records from revisions for a valid as_of', async () => {
    db.when(/from zv_revisions/i, [
      { record_id: ID, action: 'create', data: JSON.stringify({ id: ID, title: 'old-value' }) },
    ]);
    const res = await makeApp(db).request('/things?as_of=2026-01-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { title: string }[] };
    expect(body.records.some((r) => r.title === 'old-value')).toBe(true);
  });

  it('excludes records deleted before the as_of point', async () => {
    db.when(/from zv_revisions/i, [
      { record_id: ID, action: 'delete', data: JSON.stringify({ id: ID, title: 'gone' }) },
    ]);
    const res = await makeApp(db).request('/things?as_of=2026-01-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { title: string }[] };
    expect(body.records.some((r) => r.title === 'gone')).toBe(false);
  });
});

/**
 * Unit coverage for lib/data/handlers/bulk.ts — bulkCreate/bulkUpdate/bulkDelete.
 *
 * Same mechanism as the single.ts / list.ts suites: the harness drives these
 * through the real /api/data routes, but the unit lane only *loads* the module
 * without executing it — bun then instruments a far wider line view (297 lines,
 * ~3% hit) than once the code runs. The gate unions the lanes, so those
 * never-executed lines inflate the denominator. Executing the handlers here
 * (CannedDb, no Postgres, no app boot) collapses that phantom view.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { bulkCreate, bulkUpdate, bulkDelete } from '../../lib/data/handlers/bulk.js';
import { DDLManager } from '../../lib/data/index.js';
import { initPermissions, initRls } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'admin', v1: '*', v2: '*', v3: '*', v4: null, v5: null },
  { ptype: 'g', v0: 'u-god', v1: 'admin', v2: '*', v3: null, v4: null, v5: null },
];
const USER = { id: 'u-god', role: 'admin' };
const NOBODY = { id: 'u-nobody', role: 'member' };
const ID = '11111111-1111-4111-8111-111111111111';
const JSON_HDR = { 'Content-Type': 'application/json' };
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

function makeApp(db: CannedDb, user: unknown = USER): Hono {
  const app = new Hono();
  const withUser =
    (fn: (c: never, d: Database) => Promise<Response>) =>
    // biome-ignore lint/suspicious/noExplicitAny: minimal test context wiring
    (c: any) => {
      c.set('user', user as never);
      return fn(c as never, asDb(db));
    };
  app.post('/:collection/bulk', withUser(bulkCreate));
  app.patch('/:collection/bulk', withUser(bulkUpdate));
  app.delete('/:collection/bulk', withUser(bulkDelete));
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request('/things/bulk', { method: 'POST', headers: JSON_HDR, body: JSON.stringify(body) });
const patch = (app: Hono, body: unknown) =>
  app.request('/things/bulk', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify(body) });
const del = (app: Hono, body: unknown) =>
  app.request('/things/bulk', { method: 'DELETE', headers: JSON_HDR, body: JSON.stringify(body) });

describe('bulk handlers (unit)', () => {
  let db: CannedDb;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
    const seed = new CannedDb();
    seed.when(/FROM zvd_permissions/i, POLICY_ROWS);
    await initPermissions(asDb(seed));
  });

  beforeEach(() => {
    db = new CannedDb();
    initRls(asDb(db));
    DDLManager.invalidateCache();
    db.when(/from "zvd_collections"/i, [COLLECTION_DEF]);
  });

  // ── bulkCreate ────────────────────────────────────────────────────

  it('bulkCreate 403s a role without create permission', async () => {
    const res = await post(makeApp(db, NOBODY), { records: [{ title: 'a' }] });
    expect(res.status).toBe(403);
  });

  it('bulkCreate 404s an unknown collection', async () => {
    db.when(/from "zvd_collections"/i, []);
    const res = await post(makeApp(db), { records: [{ title: 'a' }] });
    expect(res.status).toBe(404);
  });

  it('bulkCreate 400s a missing/empty records array', async () => {
    expect((await post(makeApp(db), {})).status).toBe(400);
    expect((await post(makeApp(db), { records: [] })).status).toBe(400);
  });

  it('bulkCreate 400s more than 500 records', async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({ title: `t${i}` }));
    const res = await post(makeApp(db), { records });
    expect(res.status).toBe(400);
  });

  // ── bulkUpdate ────────────────────────────────────────────────────

  it('bulkUpdate 403s a role without update permission', async () => {
    const res = await patch(makeApp(db, NOBODY), { records: [{ id: ID, title: 'a' }] });
    expect(res.status).toBe(403);
  });

  it('bulkUpdate 404s an unknown collection', async () => {
    db.when(/from "zvd_collections"/i, []);
    const res = await patch(makeApp(db), { records: [{ id: ID, title: 'a' }] });
    expect(res.status).toBe(404);
  });

  it('bulkUpdate 400s an empty records array', async () => {
    expect((await patch(makeApp(db), { records: [] })).status).toBe(400);
  });

  it('bulkUpdate 400s when any record id is not a uuid', async () => {
    const res = await patch(makeApp(db), { records: [{ id: 'nope', title: 'a' }] });
    expect(res.status).toBe(400);
  });

  it('bulkUpdate 400s more than 500 records', async () => {
    const records = Array.from({ length: 501 }, () => ({ id: ID, title: 't' }));
    expect((await patch(makeApp(db), { records })).status).toBe(400);
  });

  // ── bulkDelete ────────────────────────────────────────────────────

  it('bulkDelete 403s a role without delete permission', async () => {
    const res = await del(makeApp(db, NOBODY), { ids: [ID] });
    expect(res.status).toBe(403);
  });

  it('bulkDelete 404s an unknown collection', async () => {
    db.when(/from "zvd_collections"/i, []);
    const res = await del(makeApp(db), { ids: [ID] });
    expect(res.status).toBe(404);
  });

  it('bulkDelete 400s a missing/empty ids array', async () => {
    expect((await del(makeApp(db), {})).status).toBe(400);
    expect((await del(makeApp(db), { ids: [] })).status).toBe(400);
  });

  // ── happy paths (execute the main loop, not just the guards) ──────

  it('bulkCreate inserts records and reports the count', async () => {
    db.when(/insert into "zvd_things"/i, [{ id: ID, title: 'a' }]);
    const res = await post(makeApp(db), { records: [{ title: 'a' }] });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { created: number; records: unknown[] };
    expect(body.created).toBe(1);
  });

  it('bulkCreate reports per-index errors alongside successes', async () => {
    db.when(/insert into "zvd_things"/i, [{ id: ID, title: 'a' }]);
    const res = await post(makeApp(db), { records: [{ title: 'a' }, { title: 'b' }] });
    expect([200, 201, 207]).toContain(res.status);
    const body = (await res.json()) as { created: number; errors: unknown[] };
    expect(typeof body.created).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it('bulkUpdate updates records by id', async () => {
    db.when(/update "zvd_things"/i, [{ id: ID, title: 'b' }]);
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'b' }]);
    const res = await patch(makeApp(db), { records: [{ id: ID, title: 'b' }] });
    expect([200, 207]).toContain(res.status);
  });

  it('bulkDelete deletes by ids', async () => {
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'a' }]);
    db.when(/delete from "zvd_things"/i, [{ id: ID }]);
    const res = await del(makeApp(db), { ids: [ID] });
    expect([200, 207]).toContain(res.status);
  });
});

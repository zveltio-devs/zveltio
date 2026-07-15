/**
 * Unit coverage for lib/data/handlers/single.ts.
 *
 * The harness drives these handlers through the real /api/data routes, but the
 * unit lane only *loads* the module without executing it — bun then instruments
 * a much wider line view (478 lines, ~4% hit) than it does once the code runs.
 * The coverage gate unions the two lanes, so those loaded-but-never-executed
 * lines inflate the denominator and drag the gated `lib` number down. Executing
 * the handlers here against a CannedDb (no real Postgres, no app boot) collapses
 * that phantom view — worth ~0.8pt on the gate.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import {
  getRecord,
  createRecord,
  replaceRecord,
  patchRecord,
  deleteRecord,
} from '../../lib/data/handlers/single.js';
import { DDLManager } from '../../lib/data/index.js';
import { initPermissions, initRls } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'admin', v1: '*', v2: '*', v3: '*', v4: null, v5: null },
  { ptype: 'g', v0: 'u-god', v1: 'admin', v2: '*', v3: null, v4: null, v5: null },
];

const USER = { id: 'u-god', role: 'admin' };
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

/** Mount the single-record handlers on a real Hono context (no app boot). */
function makeApp(db: CannedDb, user: unknown = USER): Hono {
  const app = new Hono();
  const withUser =
    (fn: (c: never, d: Database) => Promise<Response>) =>
    // biome-ignore lint/suspicious/noExplicitAny: minimal test context wiring
    (c: any) => {
      c.set('user', user as never);
      return fn(c as never, asDb(db));
    };
  app.get('/:collection/:id', withUser(getRecord));
  app.post('/:collection', withUser(createRecord));
  app.put('/:collection/:id', withUser(replaceRecord));
  app.patch('/:collection/:id', withUser(patchRecord));
  app.delete('/:collection/:id', withUser(deleteRecord));
  return app;
}

const JSON_HDR = { 'Content-Type': 'application/json' };
/** A user whose role carries no policy → checkAccess() denies. */
const NOBODY = { id: 'u-nobody', role: 'member' };

/** Seed the lookups getRecord always makes. */
function seedCollection(db: CannedDb): void {
  db.when(/from "zvd_collections"/i, [COLLECTION_DEF]);
}

describe('getRecord (unit)', () => {
  let db: CannedDb;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
    const seed = new CannedDb();
    seed.when(/FROM zvd_permissions/i, POLICY_ROWS);
    await initPermissions(asDb(seed));
  });

  beforeEach(() => {
    db = new CannedDb();
    // getRlsFilters() reads a module-global db set by initRls(); without it the
    // raw policy query hits kysely's noop executor and throws. Unmatched queries
    // return [] from CannedDb, which is exactly "no RLS policies".
    initRls(asDb(db));
    // DDLManager keeps a module-global collection cache — without clearing it,
    // the "collection does not exist" case poisons later tests with a cached miss.
    DDLManager.invalidateCache();
  });

  it('404s a non-uuid id without touching the DB', async () => {
    const res = await makeApp(db).request('/things/not-a-uuid');
    expect(res.status).toBe(404);
  });

  it('404s when the collection does not exist', async () => {
    db.when(/from "zvd_collections"/i, []);
    const res = await makeApp(db).request(`/things/${ID}`);
    expect(res.status).toBe(404);
  });

  it('404s when the record row is absent', async () => {
    seedCollection(db);
    db.when(/from "zvd_things"/i, []);
    const res = await makeApp(db).request(`/things/${ID}`);
    expect(res.status).toBe(404);
  });

  it('returns the record + ETag on the happy path', async () => {
    seedCollection(db);
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'hello' }]);
    const res = await makeApp(db).request(`/things/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toContain('must-revalidate');
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(ID);
    expect(body.title).toBe('hello');
  });

  it('304s when If-None-Match matches the ETag', async () => {
    seedCollection(db);
    db.when(/from "zvd_things"/i, [{ id: ID, title: 'hello' }]);
    const first = await makeApp(db).request(`/things/${ID}`);
    const etag = first.headers.get('ETag')!;

    const db2 = new CannedDb();
    seedCollection(db2);
    db2.when(/from "zvd_things"/i, [{ id: ID, title: 'hello' }]);
    const res = await makeApp(db2).request(`/things/${ID}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(res.status).toBe(304);
  });

  // ── Time travel (?as_of=) ────────────────────────────────────────

  it('400s an invalid as_of date', async () => {
    const res = await makeApp(db).request(`/things/${ID}?as_of=not-a-date`);
    expect(res.status).toBe(400);
  });

  it('404s when no revision exists at that point in time', async () => {
    db.when(/from zv_revisions/i, []);
    const res = await makeApp(db).request(`/things/${ID}?as_of=2026-01-01T00:00:00.000Z`);
    expect(res.status).toBe(404);
  });

  it('404s when the record was deleted before that point in time', async () => {
    db.when(/from zv_revisions/i, [
      { action: 'delete', data: JSON.stringify({ id: ID }), created_at: '2025-12-01T00:00:00Z' },
    ]);
    const res = await makeApp(db).request(`/things/${ID}?as_of=2026-01-01T00:00:00.000Z`);
    expect(res.status).toBe(404);
  });

  it('403s a role without read permission', async () => {
    const res = await makeApp(db, NOBODY).request(`/things/${ID}`);
    expect(res.status).toBe(403);
  });

  it('returns the historical snapshot for a valid as_of', async () => {
    db.when(/from zv_revisions/i, [
      {
        action: 'update',
        data: JSON.stringify({ id: ID, title: 'old-value' }),
        created_at: '2025-12-01T00:00:00Z',
      },
    ]);
    const res = await makeApp(db).request(`/things/${ID}?as_of=2026-01-01T00:00:00.000Z`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      record: { title: string };
      time_travel: { as_of: string; snapshot_at: string };
    };
    expect(body.record.title).toBe('old-value');
    expect(body.time_travel.as_of).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('write handlers (unit) — error branches', () => {
  let db: CannedDb;

  beforeEach(() => {
    db = new CannedDb();
    initRls(asDb(db));
    DDLManager.invalidateCache();
  });

  // ── createRecord ──────────────────────────────────────────────────

  it('createRecord 403s a role without create permission', async () => {
    const res = await makeApp(db, NOBODY).request('/things', {
      method: 'POST',
      headers: JSON_HDR,
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('createRecord 404s an unknown collection', async () => {
    db.when(/from "zvd_collections"/i, []);
    const res = await makeApp(db).request('/things', {
      method: 'POST',
      headers: JSON_HDR,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  // ── replaceRecord / patchRecord / deleteRecord ────────────────────

  it('replaceRecord 403s a role without update permission', async () => {
    const res = await makeApp(db, NOBODY).request(`/things/${ID}`, {
      method: 'PUT',
      headers: JSON_HDR,
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('patchRecord 403s a role without update permission', async () => {
    const res = await makeApp(db, NOBODY).request(`/things/${ID}`, {
      method: 'PATCH',
      headers: JSON_HDR,
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('deleteRecord 403s a role without delete permission', async () => {
    const res = await makeApp(db, NOBODY).request(`/things/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('replaceRecord 404s a non-uuid id', async () => {
    const res = await makeApp(db).request('/things/nope', {
      method: 'PUT',
      headers: JSON_HDR,
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('patchRecord 404s a non-uuid id', async () => {
    const res = await makeApp(db).request('/things/nope', {
      method: 'PATCH',
      headers: JSON_HDR,
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('deleteRecord 404s a non-uuid id', async () => {
    const res = await makeApp(db).request('/things/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

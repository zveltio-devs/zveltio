/**
 * ADR 0019 tier 1 against a live database: a `location` field is a native
 * `point`, read and written as `{lat, lng}`, and `near` / `within` answer the
 * rows inside the circle / box. Before it, `loc[near]` answered every row and
 * the field needed PostGIS. Migration 108 converts a GEOGRAPHY column.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropMaskView, sealColumns } from '../../lib/data/sealed-columns.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hloc_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
// Bucharest centre, a point ~800 m east, Ploiesti (~56 km north), Sydney.
const PLACES: [string, number, number][] = [
  ['centre', 44.4268, 26.1025],
  ['east', 44.4268, 26.1125],
  ['ploiesti', 44.9365, 26.0129],
  ['sydney', -33.8688, 151.2093],
];

d('location filters (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const post = (body: unknown) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const list = async (qs: Record<string, string>) => {
    const res = await app.request(
      `/api/data/${COLLECTION}?${new URLSearchParams({ ...qs, limit: '100' })}`,
      { headers: { cookie } },
    );
    return res;
  };
  const names = async (qs: Record<string, string>) => {
    const res = await list(qs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { name: string }[] };
    return body.records.map((r) => r.name).sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'name', type: 'text', required: false, unique: false, indexed: false },
        { name: 'loc', type: 'location', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }
    for (const [name, lat, lng] of PLACES) {
      expect((await post({ name, loc: { lat, lng } })).status).toBe(201);
    }
    expect((await post({ name: 'nowhere', loc: null })).status).toBe(201);
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

  it('stores a native point with a GiST index, reads {lat, lng}', async () => {
    const col = await sql<{ udt_name: string }>`
      SELECT udt_name FROM information_schema.columns
       WHERE table_name = ${TABLE} AND column_name = 'loc'
    `.execute(db);
    expect(col.rows[0]!.udt_name).toBe('point');
    const idx = await sql<{ def: string }>`
      SELECT indexdef AS def FROM pg_indexes WHERE tablename = ${TABLE} AND indexdef LIKE '%gist%'
    `.execute(db);
    expect(idx.rows.length).toBe(1);
    const res = await list({ 'name[eq]': 'centre' });
    const body = (await res.json()) as { records: { loc: unknown }[] };
    expect(body.records[0]!.loc).toEqual({ lat: 44.4268, lng: 26.1025 });
  });

  it.each([
    [{ lat: 91, lng: 0 }],
    [{ lat: 0, lng: 181 }],
    [{ lat: '1', lng: 2 }],
    [[1, 2]],
    ['(1,2)'],
  ])('refuses %j with 422', async (loc) => {
    expect((await post({ name: 'bad', loc })).status).toBe(422);
  });

  it('near: the rows inside the radius', async () => {
    expect(await names({ 'loc[near]': '44.4268,26.1025,500' })).toEqual(['centre']);
    expect(await names({ 'loc[near]': '44.4268,26.1025,1000' })).toEqual(['centre', 'east']);
    expect(await names({ 'loc[near]': '44.4268,26.1025,60000' })).toEqual([
      'centre',
      'east',
      'ploiesti',
    ]);
    const json = JSON.stringify({ loc: { near: { lat: -33.87, lng: 151.21, radius: 1000 } } });
    expect(await names({ filter: json })).toEqual(['sydney']);
  });

  it('within: the rows inside the box', async () => {
    expect(await names({ 'loc[within]': '44,26,45,26.11' })).toEqual(['centre', 'ploiesti']);
    expect(await names({ 'loc[within]': '-90,-180,90,180' })).toEqual([
      'centre',
      'east',
      'ploiesti',
      'sydney',
    ]);
  });

  it('a malformed or misplaced geo filter is a 400', async () => {
    for (const qs of <Record<string, string>[]>[
      { 'loc[near]': '44,26' },
      { 'loc[within]': '44,27,45,26' },
      { 'name[near]': '44,26,5' },
      { 'loc[eq]': 'x' },
    ]) {
      expect((await list(qs)).status).toBe(400);
    }
  });

  it('migration 108 converts a GEOGRAPHY location column', async () => {
    const postgis = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'postgis'
    `.execute(db);
    if (postgis.rows[0]!.n === 0) return;
    await dropMaskView(db, TABLE);
    await sql
      .raw(
        `ALTER TABLE "${TABLE}" ALTER COLUMN loc TYPE geography(point, 4326)
           USING ST_SetSRID(ST_MakePoint(loc[0], loc[1]), 4326)::geography`,
      )
      .execute(db);
    const file = new URL('../../db/migrations/sql/108_location_native_point.sql', import.meta.url);
    await sealColumns(db, COLLECTION); // the mask view the migration drops
    await sql.raw(await Bun.file(file).text()).execute(db);
    await sealColumns(db, COLLECTION); // what the boot reconcile does
    expect(await names({ 'loc[near]': '44.4268,26.1025,1000' })).toEqual(['centre', 'east']);
  });
});

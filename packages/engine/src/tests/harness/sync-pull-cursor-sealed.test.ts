/**
 * ADR 0021, applied to `POST /api/sync/pull`. Its cursor points at the last row
 * READ, which entity access may have hidden from the caller; in the clear it
 * handed out that row's `updated_at` and id, and a position the client wrote
 * was taken as is (a comparison oracle on `updated_at`). Sealed, neither: a
 * cursor that does not open restarts the collection with `resync`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import {
  createGodSession,
  getTestApp,
  harnessAvailable,
  syncPull,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `hsyncseal_${Date.now()}`;
const TABLE = `zvd_${NAME}`;
const OWNER = 'harness-sync-sealed';
const OLD = `${NAME}_old`;
const OLD_TABLE = `zvd_${OLD}`;

type PullBody = {
  changes: Array<{ id: string }>;
  cursors?: Record<string, string>;
  resync?: Record<string, boolean>;
};

d('sync pull cursor is sealed', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let hidden = '';

  const pull = async (body: Record<string, unknown>): Promise<PullBody> => {
    const res = await syncPull(app, cookie, { collections: [TABLE], ...body });
    expect(res.status).toBe(200);
    return res.body as PullBody;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: NAME,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // The newest row is the last one a pull reads, and the one hidden.
    const r = await sql<{ id: string }>`
      INSERT INTO ${sql.table(TABLE)} (title, updated_at)
      VALUES ('show', now() - interval '2 hours'), ('hide', now() - interval '1 hour')
      RETURNING id, title`.execute(db);
    hidden = (r.rows as Array<{ id: string; title: string }>).find((x) => x.title === 'hide')!.id;
    // A row written before 1970 (an import, a worker's raw SQL): its position
    // in epoch microseconds is negative.
    await DDLManager.createCollection(db, {
      name: OLD,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO ${sql.table(OLD_TABLE)} (title, updated_at)
              VALUES ('old', '1960-01-01T00:00:00Z')`.execute(db);
    entityAccessRegistry.scope(OWNER).register({
      table: TABLE,
      check: (record, _user, op) =>
        op === 'view' && (record as { title: string }).title === 'hide' ? 'deny' : 'allow',
    });
  });

  afterAll(async () => {
    entityAccessRegistry.unregisterAll(OWNER);
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "${OLD_TABLE}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', 'in', [NAME, OLD]).execute();
  });

  it('does not show the hidden row it stopped at', async () => {
    const body = await pull({});
    expect(body.changes.map((c) => c.id)).not.toContain(hidden);
    const cursor = body.cursors?.[TABLE] ?? '';
    expect(cursor).not.toBe('');
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain(hidden);
    expect(cursor).not.toContain(hidden);
    // Resumed with it, nothing is owed and nothing restarts.
    const again = await pull({ cursors: { [TABLE]: cursor } });
    expect(again.resync?.[TABLE]).toBeFalsy();
    expect(again.changes).toEqual([]);
  });

  it('restarts, with resync, from a position the client wrote', async () => {
    // Deletes complete as of now (no retention restart), from the start.
    const forged = `d${Date.now()}000:0:00000000-0000-0000-0000-000000000000`;
    const body = await pull({ cursors: { [TABLE]: forged } });
    expect(body.resync?.[TABLE]).toBe(true);
    expect(body.changes.length).toBe(1);
  });

  it('resumes from a row older than 1970 without restarting', async () => {
    // Its position is negative; refused on the way back in, every pull
    // restarted the collection with resync, and a full page looped forever.
    const res = await syncPull(app, cookie, { collections: [OLD_TABLE] });
    const first = res.body as PullBody;
    const cursor = first.cursors?.[OLD_TABLE] ?? '';
    expect(cursor).not.toBe('');
    const again = (await syncPull(app, cookie, {
      collections: [OLD_TABLE],
      cursors: { [OLD_TABLE]: cursor },
    })) as { status: number; body: PullBody };
    expect(again.status).toBe(200);
    expect(again.body.resync?.[OLD_TABLE]).toBeFalsy();
    expect(again.body.changes).toEqual([]);
  });
});

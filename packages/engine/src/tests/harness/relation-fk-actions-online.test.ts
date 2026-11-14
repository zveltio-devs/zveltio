/**
 * Changing a relation's actions re-creates its foreign key without checking
 * the rows under the table's exclusive lock (DR-38).
 *
 * `PATCH /api/relations/:id` ran `DROP CONSTRAINT …, ADD CONSTRAINT … FOREIGN
 * KEY` in one ALTER, so PostgreSQL checked every row of the child table while
 * holding ACCESS EXCLUSIVE on it and on the parent: no reads, no writes. The
 * key is now added `NOT VALID` in that short transaction and checked after it
 * commits by `VALIDATE CONSTRAINT`, which takes SHARE UPDATE EXCLUSIVE — a lock
 * readers and writers do not conflict with.
 *
 * Proof without timing: VALIDATE is held waiting on a lock the test holds (one
 * that blocks DDL, not writes) and, while it waits, the table takes a write
 * under a short lock_timeout. A key checked inside the ALTER is never seen
 * waiting apart from it.
 *
 * A VALIDATE that fails puts the previous key back, as it was: no NOT VALID key
 * is left, and the relation row keeps its actions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const SFX = Date.now();
const PARENT = `fko_p_${SFX}`;
const CHILD = `fko_c_${SFX}`;
const CT = `zvd_${CHILD}`;
const ROWS = 2000;

d('a relation action change re-creates its key without the table lock', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let relId = '';
  let parentId = '';

  const patch = async (body: Record<string, unknown>) => {
    const res = await app.request(`/api/relations/${relId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };

  /** Every foreign key on the child's `project_id`, as the database holds it. */
  const keys = async () =>
    (
      await sql<{ name: string; valid: boolean; del: string }>`
        SELECT c.conname AS name, c.convalidated AS valid, c.confdeltype::text AS del
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = ${CT}::regclass AND c.contype = 'f' AND a.attname = 'project_id'`.execute(
        db,
      )
    ).rows;

  const row = async () =>
    (
      await sql<{ on_delete: string; on_update: string }>`
        SELECT on_delete, on_update FROM zvd_relations WHERE id = ${relId}`.execute(db)
    ).rows[0];

  const waitingPid = async (pattern: string) => {
    for (let i = 0; i < 300; i++) {
      const r = await sql<{ pid: number }>`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE ${pattern}`.execute(db);
      if (r.rows[0]) return r.rows[0].pid;
      await Bun.sleep(10);
    }
    return undefined;
  };

  /** A transaction that takes `lock` on the child and holds it until released. */
  const hold = (lock: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done = db.transaction().execute(async (trx) => {
      await sql.raw(`LOCK TABLE "${CT}" IN ${lock} MODE`).execute(trx);
      await gate;
    });
    return { release, done };
  };

  /**
   * Run `change` with VALIDATE held: a writer's lock makes the ALTER wait, a
   * SHARE UPDATE EXCLUSIVE request queues behind it and is granted as the
   * ALTER commits, so the VALIDATE that follows waits on it. Writers never do.
   */
  const changeWhileValidateHeld = async (
    change: () => Promise<unknown>,
    whileHeld: (validatePid: number) => Promise<void>,
  ) => {
    const writer = hold('ROW EXCLUSIVE');
    await Bun.sleep(50);
    const changing = change();
    let ddl: ReturnType<typeof hold> | undefined;
    try {
      expect(await waitingPid(`%ALTER TABLE%${CT}%`), 'the ALTER never waited').toBeDefined();
      ddl = hold('SHARE UPDATE EXCLUSIVE');
      expect(await waitingPid(`LOCK TABLE%${CT}%SHARE UPDATE%`)).toBeDefined();
      writer.release();
      await writer.done;
      const pid = await waitingPid(`%VALIDATE CONSTRAINT%`);
      expect(pid, 'the key was never validated apart from the ALTER').toBeDefined();
      await whileHeld(pid!);
    } finally {
      writer.release();
      ddl?.release();
      await ddl?.done.catch(() => {});
    }
    return changing;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'project_id', type: 'm2o', options: { related_collection: PARENT } },
      ],
    } as never);
    parentId = (
      await asTenant(db, TENANT, (trx) =>
        sql<{
          id: string;
        }>`INSERT INTO ${sql.id(`zvd_${PARENT}`)} (title) VALUES ('p') RETURNING id`.execute(trx),
      )
    ).rows[0]!.id;
    await asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO ${sql.id(CT)} (title, project_id)
          SELECT 'r' || g, ${parentId}::uuid FROM generate_series(1, ${ROWS}) g`.execute(trx),
    );
    relId = (
      await sql<{ id: string }>`
        SELECT id FROM zvd_relations WHERE source_collection = ${CHILD}
           AND source_field = 'project_id'`.execute(db)
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${CHILD}, ${PARENT})`.execute(
      db,
    );
    await dropTestCollection(db, CHILD);
    await dropTestCollection(db, PARENT);
  });

  it('the key is validated after the ALTER commits, while the table takes writes', async () => {
    expect(await keys()).toEqual([expect.objectContaining({ valid: true, del: 'n' })]);
    let res: { status: number; body: string } | undefined;
    await changeWhileValidateHeld(
      async () => {
        res = await patch({ on_delete: 'CASCADE' });
      },
      async () => {
        await asTenant(db, TENANT, async (trx) => {
          await sql`SET LOCAL lock_timeout = '200ms'`.execute(trx);
          await sql`INSERT INTO ${sql.id(CT)} (title, project_id)
                    VALUES ('during', ${parentId}::uuid)`.execute(trx);
        });
      },
    );
    expect(res!.status, res!.body).toBe(200);
    expect(await keys()).toEqual([expect.objectContaining({ valid: true, del: 'c' })]);
    expect((await row())!.on_delete).toBe('CASCADE');
  }, 30_000);

  it('a VALIDATE that fails puts the previous key back, valid', async () => {
    const before = await keys();
    let res: { status: number; body: string } | undefined;
    await changeWhileValidateHeld(
      async () => {
        res = await patch({ on_delete: 'RESTRICT' });
      },
      async (pid) => {
        await sql`SELECT pg_cancel_backend(${pid})`.execute(db);
      },
    );
    expect(res!.status).toBeGreaterThanOrEqual(400);
    expect(await keys()).toEqual(before);
    expect((await row())!.on_delete).toBe('CASCADE');
  }, 30_000);

  it('rows a key never checked refuse the change, and no NOT VALID key is left', async () => {
    // The key drifted away and a row now points at no parent.
    const [k] = await keys();
    await sql`ALTER TABLE ${sql.id(CT)} DROP CONSTRAINT ${sql.id(k!.name)}`.execute(db);
    await asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO ${sql.id(CT)} (title, project_id) VALUES ('orphan', gen_random_uuid())`.execute(
        trx,
      ),
    );
    const res = await patch({ on_delete: 'SET NULL' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await keys()).toEqual([]);
    expect((await row())!.on_delete).toBe('CASCADE');

    // Once the row is gone the same change adds the key, valid.
    await asTenant(db, TENANT, (trx) =>
      sql`DELETE FROM ${sql.id(CT)} WHERE title = 'orphan'`.execute(trx),
    );
    expect((await patch({ on_delete: 'SET NULL' })).status).toBe(200);
    expect(await keys()).toEqual([expect.objectContaining({ valid: true, del: 'n' })]);
  }, 30_000);
});

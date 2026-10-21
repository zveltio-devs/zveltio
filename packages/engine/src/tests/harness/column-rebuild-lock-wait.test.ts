/**
 * The column guard and masking-view rebuilds give up on a held lock instead of
 * queueing the collection behind them.
 *
 * `applyColumnGuard` takes SHARE ROW EXCLUSIVE on the table; `sealColumns`
 * (`zveltio_mask_columns`, migration 075) takes ACCESS EXCLUSIVE on the view
 * every read goes through. Both ran with no `lock_timeout`: one long writer
 * (or reader of the view) and the rebuild waited for it at the head of the
 * lock queue — every write, or every read, of the collection queued behind it.
 * The post-commit refresh of a column rule change (`invalidateColumnPermCache`)
 * runs them on the pool, so nothing above bounded them.
 *
 * The bound must not leak into a caller's transaction: these join one when
 * given it, and a `SET LOCAL` would change the caller's remaining statements.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { applyColumnGuard, DDLManager, sealColumns } from '../../lib/data/index.js';
import { applyRowRulePolicy } from '../../lib/tenancy/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlockwait_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const VIEW = `zvv_${COLLECTION}`;

d('column guard / masking view / row-rule rebuild: a lock wait is bounded', () => {
  let db: Database;

  /** Run `op` while another backend holds what `hold` takes; 'hung' when it waits it out. */
  async function behind(hold: string, op: () => Promise<unknown>): Promise<unknown> {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql.raw(hold).execute(trx);
      locked();
      await held;
    });
    await lockTaken;
    const pending = op().then(
      () => 'done' as const,
      (err: unknown) => err,
    );
    try {
      return await Promise.race([pending, Bun.sleep(6_000).then(() => 'hung' as const)]);
    } finally {
      release();
      await holder;
      await pending;
    }
  }

  const rule = (column_name: string, can_read: boolean) =>
    db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name,
        role: 'member',
        can_read,
        can_write: false,
      })
      .execute();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('the guard rebuild fails with 55P03 behind a long writer', async () => {
    await rule('title', true);
    const outcome = await behind(`INSERT INTO "${TABLE}" (title) VALUES ('w')`, () =>
      applyColumnGuard(db, COLLECTION),
    );
    expect(outcome).not.toBe('hung');
    expect((outcome as { errno?: string }).errno).toBe('55P03');
  }, 30_000);

  it('the masking view rebuild fails with 55P03 behind a long reader of the view', async () => {
    await rule('note', false);
    const outcome = await behind(`SELECT * FROM "${VIEW}"`, () => sealColumns(db, COLLECTION));
    expect(outcome).not.toBe('hung');
    expect((outcome as { errno?: string }).errno).toBe('55P03');
  }, 30_000);

  it('the row-rule policy rebuild fails with 55P03 behind a long reader of the table', async () => {
    const outcome = await behind(`SELECT * FROM "${TABLE}"`, () =>
      applyRowRulePolicy(db, COLLECTION),
    );
    expect(outcome).not.toBe('hung');
    expect((outcome as { errno?: string }).errno).toBe('55P03');
  }, 30_000);

  it("leaves a caller's transaction with the lock_timeout it had", async () => {
    await db.transaction().execute(async (trx) => {
      const show = async () =>
        (await sql<{ v: string }>`SELECT current_setting('lock_timeout') AS v`.execute(trx)).rows[0]
          .v;
      const before = await show();
      await applyColumnGuard(trx, COLLECTION);
      await sealColumns(trx, COLLECTION);
      expect(await show()).toBe(before);
      await sql`SET LOCAL lock_timeout = '7s'`.execute(trx);
      await applyColumnGuard(trx, COLLECTION);
      await sealColumns(trx, COLLECTION);
      expect(await show()).toBe('7s');
    });
  }, 30_000);
});

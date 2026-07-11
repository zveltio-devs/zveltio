/**
 * Ghost DDL zero-downtime migrations (lib/data/ghost-ddl.ts) — over CannedDb.
 *
 * Pins the GitHub/PlanetScale algorithm's statement contract: ghost + changelog
 * + trigger creation with the DDL allowlist, cursor-based batch copy
 * termination, changelog replay (upsert/delete), the atomic-swap
 * lock/rename/drop sequence, the BYOD guard, and failure cleanup.
 * cancelPendingCleanups() runs after each test so the 60s post-swap cleanup
 * timer never leaks out of the suite.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { cancelPendingCleanups, GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

const MIGRATION = {
  originalTable: 'zvd_orders',
  ghostTable: '_zv_ghost_zvd_orders',
  changelogTable: '_zv_changelog_zvd_orders',
  triggerName: '_zv_trg_ghost_zvd_orders',
};

afterEach(() => {
  cancelPendingCleanups();
});

describe('createGhost', () => {
  it('creates the ghost + changelog tables and the capture trigger', async () => {
    const db = new CannedDb();
    const m = await GhostDDL.createGhost(asDb(db), 'zvd_orders', [
      'ADD COLUMN phone TEXT',
      'DROP COLUMN fax',
    ]);

    expect(m).toEqual(MIGRATION);
    expect(
      db.executed(/CREATE TABLE "_zv_ghost_zvd_orders" \(LIKE "zvd_orders" INCLUDING ALL\)/),
    ).toHaveLength(1);
    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_orders" ADD COLUMN phone TEXT/)).toHaveLength(1);
    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_orders" DROP COLUMN fax/)).toHaveLength(1);
    const changelog = db.executed(/CREATE TABLE "_zv_changelog_zvd_orders"/)[0]!;
    expect(changelog.sql).toContain("CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE'))");
    const trigger = db.executed(/CREATE TRIGGER "_zv_trg_ghost_zvd_orders"/)[0]!;
    expect(trigger.sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON "zvd_orders"');
  });

  it('rejects DDL outside the ADD/DROP/ALTER/RENAME COLUMN allowlist', async () => {
    const db = new CannedDb();
    for (const bad of [
      'DROP TABLE zvd_orders',
      'ADD CONSTRAINT evil CHECK (true)',
      'RENAME TO hijacked',
    ]) {
      await expect(GhostDDL.createGhost(asDb(db), 'zvd_orders', [bad])).rejects.toThrow(
        'Unsafe DDL statement rejected',
      );
    }
    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_orders"/)).toHaveLength(0);
  });
});

describe('batchCopy', () => {
  it('returns 0 immediately for an empty table', async () => {
    const db = new CannedDb();
    db.when(/SELECT count\(\*\) AS cnt/i, [{ cnt: '0' }]);
    const progress: Array<[number, number]> = [];

    expect(await GhostDDL.batchCopy(asDb(db), MIGRATION, (c, t) => progress.push([c, t]))).toBe(0);
    expect(progress).toEqual([[0, 0]]);
    expect(db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/)).toHaveLength(0);
  });

  it('copies a small table in a single batch', async () => {
    const db = new CannedDb();
    db.when(/SELECT count\(\*\) AS cnt/i, [{ cnt: '5' }]);
    db.whenAffected(/INSERT INTO "_zv_ghost_zvd_orders"/, 5);
    db.when(/SELECT id FROM "_zv_ghost_zvd_orders" ORDER BY id DESC LIMIT 1/i, [{ id: 'r5' }]);

    expect(await GhostDDL.batchCopy(asDb(db), MIGRATION)).toBe(5);
    const inserts = db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('uses the id cursor for subsequent batches and stops on a short batch', async () => {
    const db = new CannedDb();
    db.when(/SELECT count\(\*\) AS cnt/i, [{ cnt: '10003' }]);
    // first batch fills BATCH_SIZE, second is short → loop ends
    let call = 0;
    db.whenAffected(/INSERT INTO "_zv_ghost_zvd_orders"/, () => (++call === 1 ? 10_000 : 3));
    db.when(/SELECT id FROM "_zv_ghost_zvd_orders" ORDER BY id DESC LIMIT 1/i, [{ id: 'r10000' }]);

    expect(await GhostDDL.batchCopy(asDb(db), MIGRATION)).toBe(10_003);
    const inserts = db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).not.toContain('WHERE id >');
    expect(inserts[1]!.sql).toContain('WHERE id >');
    expect(inserts[1]!.parameters).toContain('r10000');
  });

  it('copies a large table in multiple cursor-based batches', async () => {
    const db = new CannedDb();
    db.when(/SELECT count\(\*\) AS cnt/i, [{ cnt: '15000' }]);
    db.whenAffected(
      /INSERT INTO "_zv_ghost_zvd_orders"[\s\S]*ON CONFLICT \(id\) DO NOTHING/,
      10000,
    );
    db.when(/SELECT id FROM "_zv_ghost_zvd_orders" ORDER BY id DESC/i, [{ id: 'r10000' }]);
    db.whenAffected(/INSERT INTO "_zv_ghost_zvd_orders"[\s\S]*WHERE id >/, 5000);
    db.when(/SELECT id FROM "_zv_ghost_zvd_orders" ORDER BY id DESC LIMIT 1/i, [{ id: 'r15000' }]);

    const copied = await GhostDDL.batchCopy(asDb(db), MIGRATION);
    expect(copied).toBe(15000);
    expect(db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/)).toHaveLength(2);
  });
});

describe('applyChangelog', () => {
  it('replays inserts/updates as upserts and deletes as deletes, skipping null snapshots', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_orders"/, [
      { id: '1', operation: 'INSERT', row_id: 'a', row_data: { id: 'a', total: 10 } },
      { id: '2', operation: 'UPDATE', row_id: 'a', row_data: { id: 'a', total: 20 } },
      { id: '3', operation: 'DELETE', row_id: 'b', row_data: null },
      { id: '4', operation: 'INSERT', row_id: 'c', row_data: null }, // skipped, still counted? no — continue skips count
    ]);

    const applied = await GhostDDL.applyChangelog(asDb(db), MIGRATION);
    expect(applied).toBe(3);

    const upserts = db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]!.sql).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(upserts[0]!.sql).toContain('"total" = EXCLUDED."total"');
    expect(upserts[1]!.parameters).toContain(20);

    const deletes = db.executed(/DELETE FROM "_zv_ghost_zvd_orders"/);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.parameters).toContain('b');
  });

  it('returns 0 for an empty changelog', async () => {
    const db = new CannedDb();
    expect(await GhostDDL.applyChangelog(asDb(db), MIGRATION)).toBe(0);
  });
});

describe('atomicSwap', () => {
  it('locks, renames both tables, and drops the trigger machinery in order', async () => {
    const db = new CannedDb();
    await GhostDDL.atomicSwap(asDb(db), MIGRATION);

    const swapSqls = db.log.map((q) => q.sql).filter((s) => !s.includes('_zv_changelog_'));
    const lockIdx = swapSqls.findIndex((s) => s.includes('LOCK TABLE "zvd_orders"'));
    const renameOldIdx = swapSqls.findIndex((s) =>
      s.includes('ALTER TABLE "zvd_orders" RENAME TO "_zv_old_zvd_orders"'),
    );
    const renameGhostIdx = swapSqls.findIndex((s) =>
      s.includes('ALTER TABLE "_zv_ghost_zvd_orders" RENAME TO "zvd_orders"'),
    );
    const dropTrgIdx = swapSqls.findIndex((s) =>
      s.includes('DROP TRIGGER IF EXISTS "_zv_trg_ghost_zvd_orders" ON "_zv_old_zvd_orders"'),
    );
    const dropFnIdx = swapSqls.findIndex((s) =>
      s.includes('DROP FUNCTION IF EXISTS "_zv_trg_ghost_zvd_orders_fn"()'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(swapSqls[lockIdx]).toContain('SHARE ROW EXCLUSIVE MODE');
    expect(renameOldIdx).toBeGreaterThan(lockIdx);
    expect(renameGhostIdx).toBeGreaterThan(renameOldIdx);
    expect(dropTrgIdx).toBeGreaterThan(renameGhostIdx);
    expect(dropFnIdx).toBeGreaterThan(dropTrgIdx);
  });

  it('schedules async cleanup that cancelPendingCleanups cancels', async () => {
    const db = new CannedDb();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = origSetTimeout(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setTimeout;

    try {
      await GhostDDL.atomicSwap(asDb(db), MIGRATION);
      expect(timers.length).toBeGreaterThan(0);
      cancelPendingCleanups();
    } finally {
      globalThis.setTimeout = origSetTimeout;
      cancelPendingCleanups();
    }
  });
});

describe('execute (orchestration)', () => {
  it('skips unmanaged (BYOD) tables without creating anything', async () => {
    const db = new CannedDb();
    db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: false }]);
    const phases: string[] = [];

    await GhostDDL.execute(asDb(db), 'zvd_external', ['ADD COLUMN x TEXT'], (p) => phases.push(p));

    expect(phases).toEqual(['skipped']);
    expect(db.executed(/CREATE TABLE/)).toHaveLength(0);
  });

  it('runs create → copy → changelog → swap and reports phases', async () => {
    const db = new CannedDb();
    db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
    db.when(/SELECT count\(\*\) AS cnt/i, [{ cnt: '2' }]);
    db.whenAffected(/INSERT INTO "_zv_ghost_zvd_orders"[\s\S]*DO NOTHING/, 2);
    db.when(/SELECT id FROM "_zv_ghost_zvd_orders" ORDER BY id DESC/i, [{ id: 'r2' }]);
    const phases: string[] = [];

    await GhostDDL.execute(asDb(db), 'zvd_orders', ['ADD COLUMN x TEXT'], (p) => phases.push(p));

    expect(phases[0]).toBe('creating');
    expect(phases).toContain('copying');
    expect(phases).toContain('changelog');
    expect(phases).toContain('swapping');
    expect(phases[phases.length - 1]).toBe('done');
    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_orders" RENAME TO "zvd_orders"/)).toHaveLength(
      1,
    );
  });

  it('cleans up the ghost artifacts and rethrows when a step fails', async () => {
    const db = new CannedDb();
    db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
    db.fail(/SELECT count\(\*\) AS cnt/i, new Error('copy phase exploded'));

    await expect(GhostDDL.execute(asDb(db), 'zvd_orders', ['ADD COLUMN x TEXT'])).rejects.toThrow(
      'copy phase exploded',
    );

    expect(db.executed(/DROP TABLE IF EXISTS "_zv_ghost_zvd_orders" CASCADE/)).toHaveLength(1);
    expect(db.executed(/DROP TABLE IF EXISTS "_zv_changelog_zvd_orders" CASCADE/)).toHaveLength(1);
    expect(db.executed(/DROP TRIGGER IF EXISTS "_zv_trg_ghost_zvd_orders"/)).toHaveLength(1);
    expect(db.executed(/DROP FUNCTION IF EXISTS "_zv_trg_ghost_zvd_orders_fn"/)).toHaveLength(1);
  });

  it('failure-cleanup failures are warned, and the original error still propagates', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = new CannedDb();
      db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
      db.fail(/SELECT count\(\*\) AS cnt/i, new Error('copy phase exploded'));
      db.fail(/DROP TRIGGER IF EXISTS/, new Error('trigger drop failed'));

      await expect(GhostDDL.execute(asDb(db), 'zvd_orders', ['ADD COLUMN x TEXT'])).rejects.toThrow(
        'copy phase exploded',
      );
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('DROP TRIGGER cleanup failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

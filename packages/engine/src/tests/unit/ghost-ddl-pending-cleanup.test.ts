/**
 * ghost-ddl.ts — post-swap async cleanup timer + failure-cleanup branches.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { cancelPendingCleanups, GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIGRATION = {
  originalTable: 'zvd_widgets',
  ghostTable: '_zv_ghost_zvd_widgets',
  changelogTable: '_zv_changelog_zvd_widgets',
  triggerName: '_zv_trg_ghost_zvd_widgets',
};

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

afterEach(() => {
  cancelPendingCleanups();
});

describe('GhostDDL.atomicSwap — pending cleanup timer', () => {
  it('runs the deferred DROP TABLE cleanup when the timer fires', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_widgets"/, []);

    let captured: (() => void) | null = null;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
      captured = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      await GhostDDL.atomicSwap(asDb(db), MIGRATION);
      expect(captured).not.toBeNull();
      await captured!();
      expect(db.executed(/DROP TABLE IF EXISTS "_zv_old_zvd_widgets"/)).toHaveLength(1);
      expect(db.executed(/DROP TABLE IF EXISTS "_zv_changelog_zvd_widgets"/)).toHaveLength(1);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      cancelPendingCleanups();
    }
  });

  it('swallows errors during deferred cleanup without throwing', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_widgets"/, []);
    db.fail(/DROP TABLE IF EXISTS "_zv_old_zvd_widgets"/, new Error('drop blocked'));

    let captured: (() => void) | null = null;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
      captured = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      await GhostDDL.atomicSwap(asDb(db), MIGRATION);
      await expect(captured!()).resolves.toBeUndefined();
    } finally {
      globalThis.setTimeout = origSetTimeout;
      cancelPendingCleanups();
    }
  });
});

describe('GhostDDL.execute — cleanup failure branches', () => {
  it('warns when DROP FUNCTION cleanup fails but still rethrows the original error', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = new CannedDb();
      db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
      db.fail(/SELECT count\(\*\) AS cnt/i, new Error('copy blew up'));
      db.fail(/DROP FUNCTION IF EXISTS "_zv_trg_ghost_zvd_orders_fn"/, new Error('fn drop failed'));

      await expect(GhostDDL.execute(asDb(db), 'zvd_orders', ['ADD COLUMN x TEXT'])).rejects.toThrow(
        'copy blew up',
      );
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('DROP FUNCTION cleanup failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the outer cleanup catch also fails', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = new CannedDb();
      db.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
      db.fail(/SELECT count\(\*\) AS cnt/i, new Error('copy blew up'));
      db.fail(
        /DROP TABLE IF EXISTS "_zv_ghost_zvd_orders" CASCADE/,
        new Error('drop ghost failed'),
      );

      await expect(GhostDDL.execute(asDb(db), 'zvd_orders', ['ADD COLUMN x TEXT'])).rejects.toThrow(
        'copy blew up',
      );
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('Cleanup after failure also failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * extension-context.ts — bulk update/delete skip hooks with a one-time warning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — bulk write hook skip warnings', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('warns once and skips beforeUpdate on non-id WHERE clauses', async () => {
    engineEvents.onBefore('record.beforeUpdate', async () => {
      throw new Error('should not fire');
    });

    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    const builder = {
      set: () => builder,
      where: () => builder,
      execute: async () => [],
    };
    const db = { updateTable: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-bulk-upd');

    try {
      await rdb
        .updateTable('zvd_items' as never)
        .set({ title: 'x' } as never)
        .where('tenant_id' as never, '=', 't-1' as never)
        .execute();
      await rdb
        .updateTable('zvd_items' as never)
        .set({ title: 'y' } as never)
        .where('tenant_id' as never, '=', 't-2' as never)
        .execute();
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0]![0])).toContain('bulk update');
      expect(String(warnCalls[0]![0])).toContain('ext-bulk-upd');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('warns once and skips beforeDelete on non-id WHERE clauses', async () => {
    engineEvents.onBefore('record.beforeDelete', async () => {
      throw new Error('should not fire');
    });

    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    const builder = {
      where: () => builder,
      execute: async () => [],
    };
    const db = { deleteFrom: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-bulk-del');

    try {
      await rdb
        .deleteFrom('zvd_items' as never)
        .where('status' as never, '=', 'archived' as never)
        .execute();
      await rdb
        .deleteFrom('zvd_items' as never)
        .where('status' as never, '=', 'trash' as never)
        .execute();
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0]![0])).toContain('bulk delete');
      expect(String(warnCalls[0]![0])).toContain('ext-bulk-del');
    } finally {
      console.warn = originalWarn;
    }
  });
});

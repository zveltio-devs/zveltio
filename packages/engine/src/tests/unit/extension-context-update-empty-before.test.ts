/**
 * extension-context.ts — update hook uses empty before when snapshot read misses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — update before snapshot miss', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('fires beforeUpdate with an empty before object when the row read returns nothing', async () => {
    const seen: Array<{ before: Record<string, unknown> }> = [];
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      seen.push({ before: p.before as Record<string, unknown> });
    });

    const builder = {
      set: () => builder,
      where: () => builder,
      execute: async () => [],
    };
    const db = {
      updateTable: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined,
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-miss');
    await rdb
      .updateTable('zvd_items' as never)
      .set({ title: 'new' } as never)
      .where('id' as never, '=', 'missing' as never)
      .execute();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.before).toEqual({});
  });
});

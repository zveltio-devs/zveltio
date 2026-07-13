/**
 * extension-context.ts — non-AbortHookError from update hook propagates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — update hook errors', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('rethrows unexpected errors from beforeUpdate', async () => {
    engineEvents.onBefore('record.beforeUpdate', async () => {
      throw new Error('update hook exploded');
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
            executeTakeFirst: async () => ({ id: '1', title: 'old' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-upd-boom');
    await expect(
      rdb
        .updateTable('zvd_items' as never)
        .set({ title: 'new' } as never)
        .where('id' as never, '=', '1' as never)
        .execute(),
    ).rejects.toThrow('update hook exploded');
  });
});

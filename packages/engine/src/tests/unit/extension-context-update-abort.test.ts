/**
 * extension-context.ts — update hook abort surfaces as AbortHookError.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents, AbortHookError } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — update abort', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('throws AbortHookError when beforeUpdate aborts', async () => {
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      p.abort('locked');
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
    const rdb = createRestrictedDb(db as never, 'ext-lock');
    await expect(
      rdb
        .updateTable('zvd_items' as never)
        .set({ title: 'new' } as never)
        .where('id' as never, '=', '1' as never)
        .execute(),
    ).rejects.toBeInstanceOf(AbortHookError);
  });
});

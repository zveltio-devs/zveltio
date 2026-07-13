/**
 * extension-context.ts — non-AbortHookError from delete hook propagates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — delete hook errors', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('rethrows unexpected errors from beforeDelete', async () => {
    engineEvents.onBefore('record.beforeDelete', async () => {
      throw new Error('delete hook exploded');
    });

    const builder = {
      where: () => builder,
      execute: async () => [],
    };
    const db = {
      deleteFrom: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: '1', title: 'old' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-del-boom');
    await expect(
      rdb
        .deleteFrom('zvd_items' as never)
        .where('id' as never, '=', '1' as never)
        .execute(),
    ).rejects.toThrow('delete hook exploded');
  });
});

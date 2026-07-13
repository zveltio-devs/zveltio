/**
 * extension-context.ts — delete hook abort surfaces as AbortHookError.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents, AbortHookError } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — delete abort', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('throws AbortHookError when beforeDelete aborts', async () => {
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      p.abort('retain');
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
    const rdb = createRestrictedDb(db as never, 'ext-del-abort');
    await expect(
      rdb
        .deleteFrom('zvd_items' as never)
        .where('id' as never, '=', '1' as never)
        .execute(),
    ).rejects.toBeInstanceOf(AbortHookError);
  });
});

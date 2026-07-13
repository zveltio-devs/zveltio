/**
 * extension-context.ts — non-AbortHookError from insert hook propagates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — insert hook errors', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('rethrows unexpected errors from beforeInsert', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {
      throw new Error('hook exploded');
    });

    const builder = {
      values: () => builder,
      execute: async () => [],
    };
    const db = { insertInto: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-boom');
    await expect(
      rdb
        .insertInto('zvd_items' as never)
        .values({ name: 'x' } as never)
        .execute(),
    ).rejects.toThrow('hook exploded');
  });
});

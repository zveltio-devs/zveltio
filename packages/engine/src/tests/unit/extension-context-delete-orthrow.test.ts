/**
 * extension-context.ts — delete hook executeTakeFirstOrThrow terminal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — delete executeTakeFirstOrThrow', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('fires beforeDelete and completes when executeTakeFirstOrThrow is the terminal call', async () => {
    let fired = false;
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      fired = true;
      expect(p.id).toBe('row-2');
    });

    const calls: string[] = [];
    const builder = {
      where: () => builder,
      executeTakeFirstOrThrow: async () => {
        calls.push('executeTakeFirstOrThrow');
        return { numDeletedRows: 1n };
      },
    };
    const db = {
      deleteFrom: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: 'row-2', title: 'gone' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-del-throw');
    await rdb
      .deleteFrom('zvd_items' as never)
      .where('id' as never, '=', 'row-2' as never)
      .executeTakeFirstOrThrow();
    expect(fired).toBe(true);
    expect(calls).toEqual(['executeTakeFirstOrThrow']);
  });
});

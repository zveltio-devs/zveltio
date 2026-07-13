/**
 * extension-context.ts — delete hook wrappers support terminal execute variants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — delete terminal methods', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('fires beforeDelete and completes when executeTakeFirst is the terminal call', async () => {
    let fired = false;
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      fired = true;
      expect(p.id).toBe('row-1');
      expect(p.record).toEqual({ id: 'row-1', title: 'gone' });
    });

    const calls: string[] = [];
    const builder = {
      where: () => builder,
      executeTakeFirst: async () => {
        calls.push('executeTakeFirst');
        return { numDeletedRows: 1n };
      },
    };
    const db = {
      deleteFrom: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: 'row-1', title: 'gone' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-del');
    await rdb
      .deleteFrom('zvd_items' as never)
      .where('id' as never, '=', 'row-1' as never)
      .executeTakeFirst();
    expect(fired).toBe(true);
    expect(calls).toEqual(['executeTakeFirst']);
  });
});

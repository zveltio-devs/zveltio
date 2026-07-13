/**
 * extension-context.ts — update hook wrappers support terminal execute variants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — update terminal methods', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  const stubDb = (terminal: 'executeTakeFirst' | 'executeTakeFirstOrThrow') => {
    const calls: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stub builder
    const builder: any = {
      set: () => builder,
      where: () => builder,
      [terminal]: async () => {
        calls.push(terminal);
        return { numUpdatedRows: 1n };
      },
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
    return { db, calls };
  };

  it('replays the chain when executeTakeFirst is the terminal call', async () => {
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      p.mutate({ title: 'mutated' });
    });

    const { db, calls } = stubDb('executeTakeFirst');
    const rdb = createRestrictedDb(db as never, 'ext-upd-tf');
    await rdb
      .updateTable('zvd_items' as never)
      .set({ title: 'new' } as never)
      .where('id' as never, '=', '1' as never)
      .executeTakeFirst();
    expect(calls).toEqual(['executeTakeFirst']);
  });

  it('replays the chain when executeTakeFirstOrThrow is the terminal call', async () => {
    engineEvents.onBefore('record.beforeUpdate', async () => {});

    const { db, calls } = stubDb('executeTakeFirstOrThrow');
    const rdb = createRestrictedDb(db as never, 'ext-upd-throw');
    await rdb
      .updateTable('zvd_items' as never)
      .set({ title: 'new' } as never)
      .where('id' as never, '=', '1' as never)
      .executeTakeFirstOrThrow();
    expect(calls).toEqual(['executeTakeFirstOrThrow']);
  });
});

/**
 * extension-context.ts — insert hook wrappers support all terminal execute variants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — insert terminal methods', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('replays the chain when executeTakeFirst is the terminal call', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      p.mutate({ extra: true });
    });

    const calls: string[] = [];
    const builder = {
      values: () => builder,
      executeTakeFirst: async () => {
        calls.push('executeTakeFirst');
        return { id: '1' };
      },
    };
    const db = { insertInto: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-tf');
    const row = await rdb
      .insertInto('zvd_items' as never)
      .values({ name: 'x' } as never)
      .executeTakeFirst();
    expect(row as unknown as { id: string }).toEqual({ id: '1' });
    expect(calls).toEqual(['executeTakeFirst']);
  });

  it('replays the chain when executeTakeFirstOrThrow is the terminal call', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {});

    const calls: string[] = [];
    const builder = {
      values: () => builder,
      executeTakeFirstOrThrow: async () => {
        calls.push('executeTakeFirstOrThrow');
        return { id: '2' };
      },
    };
    const db = { insertInto: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-tf-throw');
    const row = await rdb
      .insertInto('zvd_items' as never)
      .values({ name: 'y' } as never)
      .executeTakeFirstOrThrow();
    expect(row as unknown as { id: string }).toEqual({ id: '2' });
    expect(calls).toEqual(['executeTakeFirstOrThrow']);
  });
});

/**
 * extension-context.ts — transparent proxy leaf properties + delete snapshot miss.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('createRestrictedDb — proxy transparency', () => {
  it('returns non-function properties from the backing database', () => {
    const db = { dialect: 'postgres', insertInto: () => db };
    const rdb = createRestrictedDb(db as never, 'ext-a');
    expect((rdb as unknown as { dialect: string }).dialect).toBe('postgres');
  });
});

describe('hook wrappers — chain leaf properties', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('exposes non-function properties on wrapped insert builders', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {});

    const builder = {
      tag: 'leaf-marker',
      values: () => builder,
      execute: async () => [],
    };
    const db = {
      insertInto: () => builder,
    };
    const rdb = createRestrictedDb(db as never, 'ext-b');
    const wrapped = rdb.insertInto('zvd_items' as never);
    expect((wrapped as unknown as { tag: string }).tag).toBe('leaf-marker');
    await wrapped.values({ id: '1' } as never).execute();
  });

  it('uses an empty record when the before-delete snapshot read fails', async () => {
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      expect(p.record).toEqual({});
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
            executeTakeFirst: async () => {
              throw new Error('snapshot unavailable');
            },
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-c');
    await rdb
      .deleteFrom('zvd_items' as never)
      .where('id' as never, '=', 'x' as never)
      .execute();
  });
});

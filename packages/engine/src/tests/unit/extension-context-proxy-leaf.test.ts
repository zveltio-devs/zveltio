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

  it('binds non-query methods to the backing database', () => {
    let called = false;
    const db = {
      destroy: () => {
        called = true;
        return Promise.resolve();
      },
      insertInto: () => db,
    };
    const rdb = createRestrictedDb(db as never, 'ext-bind');
    (rdb as unknown as { destroy: () => Promise<void> }).destroy();
    expect(called).toBe(true);
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

  it('exposes non-function properties on wrapped update builders', async () => {
    engineEvents.onBefore('record.beforeUpdate', async () => {});

    const builder = {
      marker: 'update-leaf',
      set: () => builder,
      where: () => builder,
      execute: async () => [],
    };
    const db = {
      updateTable: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: '1' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-u');
    const wrapped = rdb.updateTable('zvd_items' as never);
    expect((wrapped as unknown as { marker: string }).marker).toBe('update-leaf');
    await wrapped
      .set({ title: 'x' } as never)
      .where('id' as never, '=', '1' as never)
      .execute();
  });

  it('exposes non-function properties on wrapped delete builders', async () => {
    engineEvents.onBefore('record.beforeDelete', async () => {});

    const builder = {
      marker: 'delete-leaf',
      where: () => builder,
      execute: async () => [],
    };
    const db = {
      deleteFrom: () => builder,
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: '1' }),
          }),
        }),
      }),
    };
    const rdb = createRestrictedDb(db as never, 'ext-d');
    const wrapped = rdb.deleteFrom('zvd_items' as never);
    expect((wrapped as unknown as { marker: string }).marker).toBe('delete-leaf');
    await wrapped.where('id' as never, '=', '1' as never).execute();
  });

  it('passes Symbol-keyed properties through insert builder proxies', () => {
    const sym = Symbol('builder-tag');
    const builder = {
      [sym]: 'symbol-leaf',
      values: () => builder,
      execute: async () => [],
    };
    const db = { insertInto: () => builder };
    const rdb = createRestrictedDb(db as never, 'ext-sym');
    const wrapped = rdb.insertInto('zvd_items' as never);
    expect((wrapped as unknown as Record<symbol, string>)[sym]).toBe('symbol-leaf');
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

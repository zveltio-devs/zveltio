import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _internalForTests, createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { AbortHookError, engineEvents } from '../../lib/runtime/event-bus.js';
import { CannedDb } from './fixtures/canned-db.js';

/**
 * S2-02 follow-up: extension-internal writes via `ctx.db` flow through
 * `record.before*` pre-write hooks the same way HTTP routes do.
 *
 * Over a real Kysely (`CannedDb`), because the guard now builds every query on
 * Kysely's own `QueryCreator` with a checked executor: what reaches the driver
 * is the compiled statement, so that is what these assert on.
 *   - inserts replay with the hook's mutated `values`;
 *   - single-row updates and deletes fire with a `before` snapshot;
 *   - bulk updates and deletes skip the hook with a one-time warning;
 *   - aborts surface as `AbortHookError`, other hook errors as themselves,
 *     and neither reaches the write.
 */

type AnyDb = any;

let canned: CannedDb;
const rdb = (ext = 'forms'): AnyDb => createRestrictedDb(canned.kysely as never, ext);
const writes = (verb: RegExp) => canned.executed(verb);

beforeEach(() => {
  engineEvents.clearPreHooks();
  canned = new CannedDb();
});
afterEach(() => engineEvents.clearPreHooks());

describe('S2-02 follow-up: extension-context internals', () => {
  it('extractSingleId returns the id for `.where("id", "=", X)`', () => {
    const calls = [
      { method: 'set', args: [{ name: 'A' }] },
      { method: 'where', args: ['id', '=', 'abc-123'] },
    ];
    expect(_internalForTests.extractSingleId(calls)).toBe('abc-123');
  });

  it('extractSingleId returns null for multi-condition WHEREs', () => {
    const calls = [
      { method: 'where', args: ['id', '=', 'abc'] },
      { method: 'where', args: ['active', '=', true] },
    ];
    expect(_internalForTests.extractSingleId(calls)).toBeNull();
  });

  it('extractSingleId returns null for non-id WHEREs and non-equality operators', () => {
    expect(
      _internalForTests.extractSingleId([{ method: 'where', args: ['email', '=', 'a@b'] }]),
    ).toBeNull();
    expect(
      _internalForTests.extractSingleId([{ method: 'where', args: ['id', '>', '100'] }]),
    ).toBeNull();
  });

  it('shouldFireHooks only fires on zvd_* user tables', () => {
    expect(_internalForTests.shouldFireHooks('zvd_contacts')).toBe(true);
    expect(_internalForTests.shouldFireHooks('zv_users')).toBe(false);
    expect(_internalForTests.shouldFireHooks('user')).toBe(false);
    expect(_internalForTests.shouldFireHooks('account')).toBe(false);
  });
});

describe('S2-02 follow-up: insertInto interception', () => {
  it('fires record.beforeInsert with the table + data + system userId', async () => {
    const seen: Array<{ collection: string; data: unknown; userId: string }> = [];
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      seen.push({ collection: p.collection, data: p.data, userId: p.userId as string });
    });
    await rdb().insertInto('zvd_forms').values({ name: 'Contact form' }).execute();
    expect(seen).toEqual([
      { collection: 'zvd_forms', data: { name: 'Contact form' }, userId: 'system:forms' },
    ]);
  });

  it('mutate() reaches the statement, through every terminal', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      p.mutate({ tenant_id: 't-1' });
    });
    canned.when(/^insert into "zvd_forms"/, [{ id: 'r1' }]);
    const db = rdb();
    expect(
      await db.insertInto('zvd_forms').values({ name: 'A' }).returning('id').execute(),
    ).toEqual([{ id: 'r1' }]);
    expect(
      await db.insertInto('zvd_forms').values({ name: 'B' }).returning('id').executeTakeFirst(),
    ).toEqual({ id: 'r1' });
    expect(
      await db
        .insertInto('zvd_forms')
        .values({ name: 'C' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: 'r1' });
    const sent = writes(/^insert into "zvd_forms"/);
    expect(sent.map((q) => q.parameters)).toEqual([
      ['A', 't-1'],
      ['B', 't-1'],
      ['C', 't-1'],
    ]);
    expect(sent[0]!.sql).toContain('("name", "tenant_id")');
  });

  it('replays the other chain methods (onConflict, returning)', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {});
    await rdb()
      .insertInto('zvd_forms')
      .values({ name: 'X' })
      .onConflict((oc: AnyDb) => oc.column('id').doNothing())
      .returningAll()
      .execute();
    expect(writes(/^insert into "zvd_forms"/)[0]!.sql).toMatch(
      /on conflict \("id"\) do nothing returning \*$/,
    );
  });

  it('abort() surfaces as AbortHookError and nothing is written', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      p.abort('disallowed');
    });
    const err = await rdb()
      .insertInto('zvd_forms')
      .values({ name: 'X' })
      .execute()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortHookError);
    expect((err as AbortHookError).reason).toBe('disallowed');
    expect(writes(/^insert/)).toHaveLength(0);
  });

  it('rethrows an unexpected hook error as itself', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {
      throw new Error('hook exploded');
    });
    await expect(rdb().insertInto('zvd_items').values({ name: 'x' }).execute()).rejects.toThrow(
      'hook exploded',
    );
  });

  it('does NOT fire hooks outside zvd_*, e.g. the extension own namespace', async () => {
    let fired = 0;
    engineEvents.onBefore('record.beforeInsert', async () => {
      fired++;
    });
    await rdb().insertInto('zv_forms_settings').values({ key: 'a', value: 'b' }).execute();
    expect(fired).toBe(0);
    expect(writes(/^insert into "zv_forms_settings"/)).toHaveLength(1);
  });

  it('a wrapped builder is not mistaken for a thenable', () => {
    expect(rdb().insertInto('zvd_forms').then).toBeUndefined();
    expect(rdb().updateTable('zvd_forms').then).toBeUndefined();
  });
});

describe('S2-02 follow-up: updateTable interception', () => {
  beforeEach(() => {
    canned.when(/^select \* from "zvd_forms" where "id" = \$1$/, [{ id: 'abc-1', name: 'old' }]);
  });

  it('fires record.beforeUpdate with the before snapshot when WHERE is a single id', async () => {
    const seen: Array<Record<string, unknown>> = [];
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      seen.push({
        id: p.id,
        collection: p.collection,
        patch: p.patch,
        before: p.before,
        userId: p.userId,
      });
    });
    await rdb().updateTable('zvd_forms').set({ name: 'new' }).where('id', '=', 'abc-1').execute();
    expect(seen).toEqual([
      {
        id: 'abc-1',
        collection: 'zvd_forms',
        patch: { name: 'new' },
        before: { id: 'abc-1', name: 'old' },
        userId: 'system:forms',
      },
    ]);
  });

  it('uses an empty before when the row is not found', async () => {
    const seen: unknown[] = [];
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      seen.push(p.before);
    });
    await rdb().updateTable('zvd_other').set({ name: 'x' }).where('id', '=', 'missing').execute();
    expect(seen).toEqual([{}]);
  });

  it('mutate() reaches the statement, through every terminal', async () => {
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      p.mutate({ title: 'mutated' });
    });
    const db = rdb();
    await db.updateTable('zvd_forms').set({ name: 'a' }).where('id', '=', 'abc-1').execute();
    await db
      .updateTable('zvd_forms')
      .set({ name: 'b' })
      .where('id', '=', 'abc-1')
      .executeTakeFirst();
    await db
      .updateTable('zvd_forms')
      .set({ name: 'c' })
      .where('id', '=', 'abc-1')
      .executeTakeFirstOrThrow();
    expect(writes(/^update "zvd_forms"/).map((q) => q.parameters)).toEqual([
      ['a', 'mutated', 'abc-1'],
      ['b', 'mutated', 'abc-1'],
      ['c', 'mutated', 'abc-1'],
    ]);
  });

  it('abort() surfaces as AbortHookError, other errors as themselves; no write either way', async () => {
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      p.abort('locked');
    });
    await expect(
      rdb().updateTable('zvd_forms').set({ name: 'n' }).where('id', '=', 'abc-1').execute(),
    ).rejects.toBeInstanceOf(AbortHookError);
    engineEvents.clearPreHooks();
    engineEvents.onBefore('record.beforeUpdate', async () => {
      throw new Error('update hook exploded');
    });
    await expect(
      rdb().updateTable('zvd_forms').set({ name: 'n' }).where('id', '=', 'abc-1').execute(),
    ).rejects.toThrow('update hook exploded');
    expect(writes(/^update/)).toHaveLength(0);
  });

  it('skips the hook on a bulk WHERE, still writes, and warns once per ext+table', async () => {
    engineEvents.onBefore('record.beforeUpdate', async () => {
      throw new Error('should not fire');
    });
    const warned: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      const db = rdb('ext-bulk-upd');
      await db
        .updateTable('zvd_items')
        .set({ title: 'x' })
        .where('tenant_id', '=', 't-1')
        .execute();
      await db
        .updateTable('zvd_items')
        .set({ title: 'y' })
        .where('tenant_id', '=', 't-2')
        .execute();
    } finally {
      console.warn = originalWarn;
    }
    expect(writes(/^update "zvd_items"/)).toHaveLength(2);
    expect(warned).toHaveLength(1);
    expect(String(warned[0]![0])).toContain('bulk update');
    expect(String(warned[0]![0])).toContain('ext-bulk-upd');
  });
});

describe('S2-02 follow-up: deleteFrom interception', () => {
  beforeEach(() => {
    canned.when(/^select \* from "zvd_forms" where "id" = \$1$/, [{ id: 'x', name: 'old' }]);
  });

  it('fires record.beforeDelete with id + record snapshot, through every terminal', async () => {
    const seen: Array<Record<string, unknown>> = [];
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      seen.push({ id: p.id, record: p.record, userId: p.userId });
    });
    const db = rdb();
    await db.deleteFrom('zvd_forms').where('id', '=', 'x').execute();
    await db.deleteFrom('zvd_forms').where('id', '=', 'x').executeTakeFirst();
    await db.deleteFrom('zvd_forms').where('id', '=', 'x').executeTakeFirstOrThrow();
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ id: 'x', record: { id: 'x', name: 'old' }, userId: 'system:forms' });
    expect(writes(/^delete from "zvd_forms"/)).toHaveLength(3);
  });

  it('uses an empty record when the snapshot read fails', async () => {
    canned.fail(/^select \* from "zvd_forms"/, new Error('snapshot unavailable'));
    const seen: unknown[] = [];
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      seen.push(p.record);
    });
    await rdb().deleteFrom('zvd_forms').where('id', '=', 'x').execute();
    expect(seen).toEqual([{}]);
  });

  it('abort() and other hook errors prevent the delete from running', async () => {
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      p.abort('not allowed');
    });
    await expect(
      rdb().deleteFrom('zvd_forms').where('id', '=', 'x').execute(),
    ).rejects.toBeInstanceOf(AbortHookError);
    engineEvents.clearPreHooks();
    engineEvents.onBefore('record.beforeDelete', async () => {
      throw new Error('delete hook exploded');
    });
    await expect(rdb().deleteFrom('zvd_forms').where('id', '=', 'x').execute()).rejects.toThrow(
      'delete hook exploded',
    );
    expect(writes(/^delete/)).toHaveLength(0);
  });

  it('skips the hook on a bulk WHERE, still deletes, and warns once per ext+table', async () => {
    engineEvents.onBefore('record.beforeDelete', async () => {
      throw new Error('should not fire');
    });
    const warned: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      const db = rdb('ext-bulk-del');
      await db.deleteFrom('zvd_items').where('status', '=', 'archived').execute();
      await db.deleteFrom('zvd_items').where('status', '=', 'trash').execute();
    } finally {
      console.warn = originalWarn;
    }
    expect(writes(/^delete from "zvd_items"/)).toHaveLength(2);
    expect(warned).toHaveLength(1);
    expect(String(warned[0]![0])).toContain('bulk delete');
    expect(String(warned[0]![0])).toContain('ext-bulk-del');
  });
});

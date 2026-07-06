import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createRestrictedDb, _internalForTests } from '../../lib/extension-context.js';
import { engineEvents, AbortHookError } from '../../lib/runtime/event-bus.js';

/**
 * S2-02 follow-up: extension-internal writes via `ctx.db` flow through
 * `record.before*` pre-write hooks the same way HTTP routes do.
 *
 * These tests stub out Kysely with a recorder builder so we can verify:
 *   - the fast path (no hooks registered) returns the raw builder;
 *   - when hooks ARE registered, the chain is replayed against a fresh
 *     builder with mutated `values` / `set`;
 *   - aborts surface as `AbortHookError`;
 *   - update / delete only intercept single-row WHERE-by-id (bulk skips
 *     with a one-time warning per table+ext).
 *
 * Stub DB: each `insertInto / updateTable / deleteFrom / selectFrom`
 * returns a chainable recorder. `.execute()` resolves with whatever
 * `__result` was set, defaulting to an empty array.
 */

// ── Recorder builder ────────────────────────────────────────────────────────

interface CallLog {
  method: string;
  args: unknown[];
}

function makeRecorder(initial: CallLog[] = []): any {
  const log: CallLog[] = initial;
  const state: { result: unknown } = { result: undefined };
  const proxy: any = new Proxy(() => {}, {
    get(_t, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === '__log') return log;
      if (prop === '__state') return state;
      if (prop === '__then' || prop === 'then') return undefined;
      if (prop === 'execute' || prop === 'executeTakeFirst' || prop === 'executeTakeFirstOrThrow') {
        return async (...args: unknown[]) => {
          log.push({ method: prop, args });
          return state.result ?? (prop === 'execute' ? [] : undefined);
        };
      }
      return (...args: unknown[]) => {
        log.push({ method: prop, args });
        return proxy;
      };
    },
    set(_t, prop: string | symbol, value: unknown) {
      if (prop === '__result') {
        state.result = value;
        return true;
      }
      return true;
    },
  });
  return proxy;
}

function makeStubDb(): any {
  const inserts: any[] = [];
  const updates: any[] = [];
  const deletes: any[] = [];
  const selects: any[] = [];
  const db: any = {
    insertInto(table: string) {
      const r = makeRecorder([{ method: 'insertInto', args: [table] }]);
      inserts.push(r);
      return r;
    },
    updateTable(table: string) {
      const r = makeRecorder([{ method: 'updateTable', args: [table] }]);
      updates.push(r);
      return r;
    },
    deleteFrom(table: string) {
      const r = makeRecorder([{ method: 'deleteFrom', args: [table] }]);
      deletes.push(r);
      return r;
    },
    selectFrom(table: string) {
      const r = makeRecorder([{ method: 'selectFrom', args: [table] }]);
      selects.push(r);
      return r;
    },
  };
  db.__inserts = inserts;
  db.__updates = updates;
  db.__deletes = deletes;
  db.__selects = selects;
  return db;
}

// ── Tests ───────────────────────────────────────────────────────────────────

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

  it('extractSingleId returns null for non-id WHEREs', () => {
    expect(
      _internalForTests.extractSingleId([{ method: 'where', args: ['email', '=', 'a@b'] }]),
    ).toBeNull();
  });

  it('extractSingleId returns null for non-equality operators', () => {
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
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('FAST PATH: returns the raw builder when no hooks are registered', async () => {
    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    // Use the bare insertInto chain. The recorder is the SAME object as
    // db.__inserts[0], proving we didn't wrap.
    const builder = rdb.insertInto('zvd_forms' as any);
    expect(builder).toBe(db.__inserts[0]);
  });

  it('fires record.beforeInsert with the table + data + system userId', async () => {
    const seen: any[] = [];
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      seen.push({ ...p, abort: undefined, mutate: undefined });
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .insertInto('zvd_forms' as any)
      .values({ name: 'Contact form' } as any)
      .execute();

    expect(seen).toHaveLength(1);
    expect(seen[0].collection).toBe('zvd_forms');
    expect(seen[0].data).toEqual({ name: 'Contact form' });
    expect(seen[0].userId).toBe('system:forms');
  });

  it('mutate() merges into values before execute', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      p.mutate({ tenant_id: 't-1' });
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .insertInto('zvd_forms' as any)
      .values({ name: 'X' } as any)
      .execute();

    // Two inserts on the stub DB: the recorder created for the FIRST
    // .insertInto() call (used by the wrapper to discover the chain),
    // and the REPLAY .insertInto() (with mutated values). We assert the
    // replay used mutated values.
    expect(db.__inserts.length).toBeGreaterThanOrEqual(2);
    const replay = db.__inserts[db.__inserts.length - 1];
    const valuesCall = replay.__log.find((c: any) => c.method === 'values');
    expect(valuesCall.args[0]).toEqual({ name: 'X', tenant_id: 't-1' });
  });

  it('abort() surfaces as AbortHookError', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      p.abort('disallowed');
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    let caught: Error | null = null;
    try {
      await rdb
        .insertInto('zvd_forms' as any)
        .values({ name: 'X' } as any)
        .execute();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(AbortHookError);
    expect((caught as AbortHookError).reason).toBe('disallowed');
  });

  it('passes other chain methods through (onConflict, returning, etc.)', async () => {
    engineEvents.onBefore('record.beforeInsert', async () => {
      /* no-op */
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .insertInto('zvd_forms' as any)
      .values({ name: 'X' } as any)
      .onConflict((oc: any) => oc.column('id').doNothing())
      .returningAll()
      .execute();

    // Replay should include values + onConflict + returningAll + execute.
    const replay = db.__inserts[db.__inserts.length - 1];
    const methods = replay.__log.map((c: any) => c.method);
    expect(methods).toContain('values');
    expect(methods).toContain('onConflict');
    expect(methods).toContain('returningAll');
    expect(methods).toContain('execute');
  });

  it('does NOT fire hooks for non-zvd tables (e.g. user, account)', async () => {
    let fired = 0;
    engineEvents.onBefore('record.beforeInsert', async () => {
      fired++;
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .insertInto('user' as any)
      .values({ email: 'a@b.com' } as any)
      .execute();

    expect(fired).toBe(0);
    // Fast path: no replay needed, only one recorder created.
    expect(db.__inserts).toHaveLength(1);
  });
});

describe('S2-02 follow-up: updateTable interception', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('fires record.beforeUpdate when WHERE is a single id', async () => {
    const seen: any[] = [];
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      seen.push({ ...p, abort: undefined, mutate: undefined });
    });

    const db = makeStubDb();
    // Stub `before` row read.
    const origSelectFrom = db.selectFrom;
    db.selectFrom = (table: string) => {
      const r = origSelectFrom.call(db, table);
      (r as any).__result = { id: 'abc-1', name: 'old' };
      return r;
    };
    const rdb = createRestrictedDb(db, 'forms');

    await rdb
      .updateTable('zvd_forms' as any)
      .set({ name: 'new' } as any)
      .where('id' as any, '=', 'abc-1')
      .execute();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('abc-1');
    expect(seen[0].collection).toBe('zvd_forms');
    expect(seen[0].patch).toEqual({ name: 'new' });
    expect(seen[0].before).toEqual({ id: 'abc-1', name: 'old' });
    expect(seen[0].userId).toBe('system:forms');
  });

  it('mutate() merges into patch before replay', async () => {
    engineEvents.onBefore('record.beforeUpdate', async (p) => {
      p.mutate({ updated_at: 'now()' });
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .updateTable('zvd_forms' as any)
      .set({ name: 'new' } as any)
      .where('id' as any, '=', 'abc-1')
      .execute();

    const replay = db.__updates[db.__updates.length - 1];
    const setCall = replay.__log.find((c: any) => c.method === 'set');
    expect(setCall.args[0]).toEqual({ name: 'new', updated_at: 'now()' });
  });

  it('skips the hook on bulk WHERE (and warns once per ext+table)', async () => {
    let fired = 0;
    engineEvents.onBefore('record.beforeUpdate', async () => {
      fired++;
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    await rdb
      .updateTable('zvd_forms' as any)
      .set({ active: false } as any)
      .where('tenant_id' as any, '=', 't-x')
      .execute();

    expect(fired).toBe(0);
    // The original recorder was executed (skip-replay path).
    const original = db.__updates[0];
    expect(original.__log.some((c: any) => c.method === 'execute')).toBe(true);
  });
});

describe('S2-02 follow-up: deleteFrom interception', () => {
  beforeEach(() => engineEvents.clearPreHooks());
  afterEach(() => engineEvents.clearPreHooks());

  it('fires record.beforeDelete with id + record snapshot', async () => {
    const seen: any[] = [];
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      seen.push({ ...p, abort: undefined });
    });

    const db = makeStubDb();
    const origSelectFrom = db.selectFrom;
    db.selectFrom = (table: string) => {
      const r = origSelectFrom.call(db, table);
      (r as any).__result = { id: 'x', name: 'old' };
      return r;
    };
    const rdb = createRestrictedDb(db, 'forms');

    await rdb
      .deleteFrom('zvd_forms' as any)
      .where('id' as any, '=', 'x')
      .execute();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('x');
    expect(seen[0].record).toEqual({ id: 'x', name: 'old' });
    expect(seen[0].userId).toBe('system:forms');
  });

  it('abort() prevents the delete from running', async () => {
    engineEvents.onBefore('record.beforeDelete', async (p) => {
      p.abort('not allowed');
    });

    const db = makeStubDb();
    const rdb = createRestrictedDb(db, 'forms');
    let caught: Error | null = null;
    try {
      await rdb
        .deleteFrom('zvd_forms' as any)
        .where('id' as any, '=', 'x')
        .execute();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(AbortHookError);
    // The DELETE never reached execute on the recorder — only selectFrom
    // (for `before` snapshot) should have logged execute calls.
    const original = db.__deletes[0];
    expect(original.__log.some((c: any) => c.method === 'execute')).toBe(false);
  });
});

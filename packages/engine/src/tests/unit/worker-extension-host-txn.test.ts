// The host's bookkeeping for `db.transaction()` outside a request (owner
// decision 4), against a recording pool: what reaches the connection, and what is
// refused before anything does. The database side is in
// tests/harness/worker-host-transaction.test.ts.
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import * as bunSql from '../../db/bun-sql-dialect.js';
import { workerSqlEngineTables } from '../../lib/extensions/worker-sql-policy.js';
import { _internalForTests, WorkerExtensionHost } from '../../lib/worker-extension-host.js';
import type { DbQueryRequest, HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';

await workerSqlEngineTables();

let spy: { mockRestore(): void } | undefined;
afterEach(() => spy?.mockRestore());

/** A pool whose connections record every statement; `fail` names one that throws. */
function recordingPool(opts: { role?: string | null; fail?: string } = {}) {
  const ran: string[] = [];
  let reserved = 0;
  let released = 0;
  spy = spyOn(bunSql, 'getActiveBunPool').mockReturnValue({
    reserve: async () => {
      reserved++;
      return {
        unsafe: async (sql: string) => {
          ran.push(sql);
          if (opts.fail && sql.startsWith(opts.fail)) throw new Error(`${opts.fail} failed`);
          return sql.includes('FROM pg_roles')
            ? [{ role: 'role' in opts ? opts.role : 'zveltio_worker' }]
            : [];
        },
        release: () => void released++,
      };
    },
  } as never);
  return { ran, counts: () => ({ reserved, released }) };
}

function managed() {
  const host = new WorkerExtensionHost(new Hono());
  const posted: HostToWorkerMessage[] = [];
  const m = {
    name: 'htx',
    worker: { postMessage: (msg: HostToWorkerMessage) => posted.push(msg) },
    invokeTenants: new Map(),
  } as never as Parameters<typeof _internalForTests.dispatchMessage>[1];
  let n = 0;
  const send = async (msg: Partial<DbQueryRequest>) => {
    const id = `q${++n}`;
    _internalForTests.dispatchMessage(host, m, {
      type: 'db:query',
      id,
      sql: '',
      params: [],
      ...msg,
    });
    for (let i = 0; i < 50 && !posted.some((p) => 'id' in p && p.id === id); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    return posted.find((p) => 'id' in p && p.id === id) as { type: string; error?: string };
  };
  return { m, send };
}

describe('host transaction outside a request', () => {
  it('begin opens it, statements join it, the outermost release commits it', async () => {
    const { ran, counts } = recordingPool();
    const { send } = managed();
    expect((await send({ txn: 't1', savepoint: 'begin' })).type).toBe('db:ok');
    expect((await send({ txn: 't1', sql: 'SELECT 1' })).type).toBe('db:ok');
    expect((await send({ txn: 't1', savepoint: 'begin' })).type).toBe('db:ok');
    expect((await send({ txn: 't1', savepoint: 'rollback' })).type).toBe('db:ok');
    expect((await send({ txn: 't1', savepoint: 'release' })).type).toBe('db:ok');
    expect(ran.filter((s) => !s.includes('pg_roles') && !s.startsWith('SET LOCAL'))).toEqual([
      'BEGIN',
      'SELECT 1',
      'SAVEPOINT zv_sp_1',
      'ROLLBACK TO SAVEPOINT zv_sp_1',
      'RELEASE SAVEPOINT zv_sp_1',
      'COMMIT',
      'DISCARD TEMP',
    ]);
    expect(counts()).toEqual({ reserved: 1, released: 1 });
    // Ended: its id names nothing any more.
    expect((await send({ txn: 't1', sql: 'SELECT 2' })).error).toContain('is over');
  });

  it('refuses a statement on a transaction never opened; a rollback of one is a no-op', async () => {
    const { ran } = recordingPool();
    const { send } = managed();
    expect((await send({ txn: 'nope', sql: 'SELECT 1' })).error).toContain('never opened');
    expect((await send({ txn: 'nope', savepoint: 'rollback' })).type).toBe('db:ok');
    expect(ran).toEqual([]);
  });

  it('refuses a statement naming another invocation than the one it was opened in', async () => {
    recordingPool();
    const { m, send } = managed();
    m.invokeTenants.set('inv-a', { tenantId: null });
    m.invokeTenants.set('inv-b', { tenantId: null });
    await send({ txn: 't1', savepoint: 'begin', requestId: 'inv-a' });
    const res = await send({ txn: 't1', sql: 'SELECT 1', requestId: 'inv-b' });
    expect(res.error).toContain('belongs to other work');
  });

  it('rolls back when its invocation is over', async () => {
    const { ran } = recordingPool();
    const { m, send } = managed();
    m.invokeTenants.set('inv-a', { tenantId: null });
    await send({ txn: 't1', savepoint: 'begin', requestId: 'inv-a' });
    m.invokeTenants.delete('inv-a');
    expect((await send({ txn: 't1', sql: 'SELECT 1', requestId: 'inv-a' })).error).toContain(
      'is over',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toContain('ROLLBACK');
    expect(ran).not.toContain('SELECT 1');
  });

  it('caps the transactions one worker holds open', async () => {
    recordingPool();
    const { send } = managed();
    for (const t of ['a', 'b', 'c', 'd']) {
      expect((await send({ txn: t, savepoint: 'begin' })).type).toBe('db:ok');
    }
    expect((await send({ txn: 'e', savepoint: 'begin' })).error).toContain('already holds 4');
    // One ended frees a slot.
    await send({ txn: 'a', savepoint: 'rollback' });
    expect((await send({ txn: 'e', savepoint: 'begin' })).type).toBe('db:ok');
  });

  it('a begin that fails leaves nothing open', async () => {
    const { counts } = recordingPool({ role: null });
    const { send } = managed();
    expect((await send({ txn: 't1', savepoint: 'begin' })).error).toContain('Worker SQL refused');
    expect(counts()).toEqual({ reserved: 1, released: 1 });
    expect((await send({ txn: 't1', sql: 'SELECT 1' })).error).toContain('never opened');
  });

  it('a COMMIT that fails is an error, not a success', async () => {
    recordingPool({ fail: 'COMMIT' });
    const { send } = managed();
    await send({ txn: 't1', savepoint: 'begin' });
    expect((await send({ txn: 't1', savepoint: 'release' })).error).toContain(
      'could not be committed; nothing it wrote was kept (COMMIT failed)',
    );
  });

  it('the worker dying rolls back every one it holds', async () => {
    const { ran, counts } = recordingPool();
    const { m, send } = managed();
    await send({ txn: 'a', savepoint: 'begin' });
    await send({ txn: 'b', savepoint: 'begin' });
    (m as unknown as { pendingInvokes: Map<string, unknown> }).pendingInvokes = new Map();
    _internalForTests.failPendingRoutes(m);
    await new Promise((r) => setTimeout(r, 5));
    expect(ran.filter((s) => s === 'ROLLBACK')).toHaveLength(2);
    expect(counts()).toEqual({ reserved: 2, released: 2 });
  });

  it('inside a request the transaction id is ignored: the request is the transaction', async () => {
    const { ran, counts } = recordingPool();
    const { m, send } = managed();
    m.invokeTenants.set('req', { tenantId: null, txn: _internalForTests.newRequestTxn() });
    await send({ txn: 't1', savepoint: 'begin', requestId: 'req' });
    await send({ txn: 't1', sql: 'SELECT 1', requestId: 'req' });
    expect(ran).toContain('SAVEPOINT zv_sp_1');
    expect(counts().reserved).toBe(1);
  });
});

// The worker side of the step-7 ctx contract (worker-extension-ctx.ts): what each
// member sends across the bridge, and what it refuses by name.
import { describe, expect, it, spyOn } from 'bun:test';
import { buildWorkerCtx, type WorkerBridge } from '../../lib/worker-extension-ctx.js';

type Call = [string, unknown[]];

function bridge(over: Partial<WorkerBridge> = {}) {
  const queries: Call[] = [];
  const hosts: Call[] = [];
  const services: Call[] = [];
  const savepoints: string[] = [];
  const b: WorkerBridge = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      return Object.assign([{ n: 1 }], { count: 3 });
    },
    savepoint: async (op) => {
      savepoints.push(op);
    },
    host: async (op, args) => {
      hosts.push([op, args]);
      return op === 'checkPermission' ? true : null;
    },
    serviceCall: async (name, args) => {
      services.push([name, args]);
      return 'svc';
    },
    registerService: () => {},
    listeners: new Map(),
    config: { vars: { A: '1' } },
    ...over,
  };
  const { ctx, settled } = buildWorkerCtx(b);
  return { ctx: ctx as any, settled, b, queries, hosts, services, savepoints };
}

describe('worker ctx: db', () => {
  it('is Kysely, compiled by its Postgres compiler, sent as one statement with its parameters', async () => {
    const { ctx, queries } = bridge();
    const res = await ctx.db
      .updateTable('zv_x_items')
      .set({ note: 'n' })
      .where('tag', '=', 'k')
      .executeTakeFirst();
    expect(queries).toEqual([['update "zv_x_items" set "note" = $1 where "tag" = $2', ['n', 'k']]]);
    // From the bridged `count`, as BunSqlSmartConnection builds it.
    expect(res.numUpdatedRows).toBe(3n);
  });

  it('refuses a stream by name', async () => {
    const { ctx } = bridge();
    const rows = ctx.db.selectFrom('t').selectAll().stream();
    await expect(rows.next()).rejects.toThrow('ctx.db stream() is not available');
  });

  it('keeps the raw query form', async () => {
    const { ctx, queries } = bridge();
    expect(await ctx.db.query('SELECT $1', 7)).toEqual([{ n: 1 }]);
    expect(queries).toEqual([['SELECT $1', [7]]]);
  });

  it('db.transaction() is a savepoint the host names, nested, released or rolled back', async () => {
    const { ctx, savepoints, queries } = bridge();
    const out = await ctx.db.transaction().execute(async () => {
      await ctx.db.transaction().execute(async (trx: any) => {
        await trx.selectFrom('zv_x_items').selectAll().execute();
      });
      await ctx.db
        .transaction()
        .execute(async () => {
          throw new Error('inner');
        })
        .catch(() => undefined);
      return 1;
    });
    expect(out).toBe(1);
    expect(savepoints).toEqual(['begin', 'begin', 'release', 'begin', 'rollback', 'release']);
    // No transaction-control text crosses the bridge.
    expect(queries.map(([q]) => q)).toEqual(['select * from "zv_x_items"']);
  });

  it('refuses transaction settings a savepoint cannot carry', async () => {
    const { ctx, savepoints } = bridge();
    await expect(
      ctx.db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async () => 1),
    ).rejects.toThrow('ctx.db.transaction() settings is not available');
    expect(savepoints).toEqual([]);
  });

  it('reqDb is the same request-scoped db', () => {
    const { ctx } = bridge();
    expect(ctx.reqDb({})).toBe(ctx.db);
  });
});

describe('worker ctx: host members', () => {
  it('asks the host for checkPermission and the session, naming no identity of its own', async () => {
    const { ctx, hosts } = bridge();
    expect(await ctx.checkPermission('u1', 'crm', 'read')).toBe(true);
    expect(await ctx.auth.api.getSession({ headers: new Headers({ cookie: 'forged' }) })).toBe(
      null,
    );
    // The headers the extension passes are not sent: the host uses the request's own.
    expect(hosts).toEqual([
      ['checkPermission', ['u1', 'crm', 'read']],
      ['getSession', []],
    ]);
  });

  it('hands over its own config', () => {
    expect(bridge().ctx.config).toEqual({ vars: { A: '1' } });
  });

  it('services.get returns the function, and only calling it crosses', async () => {
    const { ctx, services } = bridge();
    const fn = ctx.services.get('a.b');
    expect(typeof fn).toBe('function');
    expect(services).toEqual([]);
    expect(await fn(1, 2)).toBe('svc');
    expect(services).toEqual([['a.b', [1, 2]]]);
  });
});

describe('worker ctx: events', () => {
  it('on keeps the listener under a key the host delivers to, and off drops it', async () => {
    const { ctx, b, hosts, settled } = bridge();
    const handler = () => {};
    const off = ctx.events.on('x.ping', handler);
    await settled();
    const [[op, [event, key]]] = hosts as [[string, [string, string]]];
    expect([op, event]).toEqual(['on', 'x.ping']);
    expect(b.listeners.get(key)).toBe(handler);
    off();
    expect(b.listeners.has(key)).toBe(false);
    expect(hosts[1]).toEqual(['off', [key]]);
  });

  it('a subscription the host refuses fails the load', async () => {
    const { ctx, b, settled } = bridge({
      host: async () => {
        throw new Error('may not listen to "record.created"');
      },
    });
    ctx.events.on('record.created', () => {});
    await expect(settled()).rejects.toThrow('may not listen to "record.created"');
    expect(b.listeners.size).toBe(0);
  });

  it('an emit the host refuses is logged, not thrown', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { ctx } = bridge({
        host: async () => {
          throw new Error('refused');
        },
      });
      ctx.events.emit('record.created', {});
      await new Promise((r) => setTimeout(r, 0));
      expect(errors.mock.calls.flat().join(' ')).toContain(
        'ctx.events.emit("record.created"): refused',
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('emit does not wait, emitAsync does', async () => {
    const { ctx, hosts } = bridge();
    ctx.events.emit('x.a', { n: 1 });
    await ctx.events.emitAsync('x.b', { n: 2 });
    expect(hosts).toEqual([
      ['emit', ['x.a', { n: 1 }, false]],
      ['emit', ['x.b', { n: 2 }, true]],
    ]);
  });

  it('refuses a pre-write hook by name', () => {
    expect(() => bridge().ctx.events.onBefore('record.beforeInsert', () => {})).toThrow(
      'ctx.events.onBefore is not available to a worker-isolated extension',
    );
  });
});

describe('worker ctx: what cannot cross', () => {
  for (const member of ['internals', 'fieldTypeRegistry', 'queryAlter', 'DDLManager', 'adminDb']) {
    it(`refuses ctx.${member} by name`, () => {
      const { ctx } = bridge();
      expect(() => ctx[member]).toThrow(
        `ctx.${member} is not available to a worker-isolated extension`,
      );
    });
  }

  it('is not tripped by spreading the ctx', () => {
    const { ctx } = bridge();
    expect(() => ({ ...ctx })).not.toThrow();
  });
});

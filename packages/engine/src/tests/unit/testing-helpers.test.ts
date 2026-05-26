import { describe, it, expect } from 'bun:test';
import {
  createTestContext,
  createTestApp,
  mockDb,
  mockEventBus,
  mockServiceRegistry,
  mockAuth,
} from '@zveltio/sdk/testing';
import type { ZveltioExtension } from '@zveltio/sdk/extension';

describe('mockDb', () => {
  it('returns empty array for .execute() with no preset', async () => {
    const db = mockDb();
    const result = await db.selectFrom('users').selectAll().execute();
    expect(result).toEqual([]);
  });

  it('returns undefined for .executeTakeFirst() with no preset', async () => {
    const db = mockDb();
    const result = await db.selectFrom('users').selectAll().executeTakeFirst();
    expect(result).toBeUndefined();
  });

  it('throws on .executeTakeFirstOrThrow() with no preset', async () => {
    const db = mockDb();
    await expect(db.selectFrom('users').selectAll().executeTakeFirstOrThrow()).rejects.toThrow(
      'no preset',
    );
  });

  it('returns presets matched by exact chain', async () => {
    // Note: chain captures METHOD NAMES only (not call args). Use suffix
    // matches or function presets when you need to differentiate by args.
    const db = mockDb({
      'selectFrom.selectAll.execute': [{ id: '1' }, { id: '2' }],
    });
    const result = await db.selectFrom('users').selectAll().execute();
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('returns presets matched by suffix', async () => {
    const db = mockDb({
      'selectAll.execute': [{ marker: 'suffix-match' }],
    });
    const result = await db.selectFrom('whatever').selectAll().execute();
    expect(result).toEqual([{ marker: 'suffix-match' }]);
  });

  it('records call chain + args', async () => {
    const db = mockDb();
    await db.selectFrom('users').where('id', '=', 'abc').executeTakeFirst();
    const last = db.calls[db.calls.length - 1];
    expect(last.chain).toContain('executeTakeFirst');
    expect(last.args).toEqual([]);
  });

  it('preset() lets you add after construction', async () => {
    const db = mockDb();
    db.preset('selectAll.execute', [{ id: 'late' }]);
    const result = await db.selectFrom('x').selectAll().execute();
    expect(result).toEqual([{ id: 'late' }]);
  });

  it('reset() clears calls but keeps presets', async () => {
    const db = mockDb({ execute: [{ kept: true }] });
    await db.selectFrom('x').execute();
    // Each call in the chain is recorded — selectFrom('x') + execute() = 2.
    expect(db.calls.length).toBeGreaterThan(0);
    db.reset();
    expect(db.calls).toHaveLength(0);
    const result = await db.selectFrom('x').execute();
    expect(result).toEqual([{ kept: true }]);
  });

  it('preset can be a function for dynamic responses', async () => {
    const db = mockDb({
      'where.execute': (..._args: unknown[]) => [{ generated: 'dynamic' }],
    });
    const result = await db.selectFrom('x').where('y').execute();
    expect(result).toEqual([{ generated: 'dynamic' }]);
  });
});

describe('mockEventBus', () => {
  it('records emit() calls', () => {
    const bus = mockEventBus();
    bus.emit('record.created', { id: '1' });
    bus.emit('record.updated', { id: '2' });
    expect(bus.emitted).toHaveLength(2);
    expect(bus.emitted[0]).toEqual({ event: 'record.created', payload: { id: '1' } });
  });

  it('on() listeners receive emitted payloads', () => {
    const bus = mockEventBus();
    const received: unknown[] = [];
    bus.on('user.login', (p) => received.push(p));
    bus.emit('user.login', { userId: 'u1' });
    expect(received).toEqual([{ userId: 'u1' }]);
  });

  it('onBefore handlers can mutate the payload', async () => {
    const bus = mockEventBus();
    bus.onBefore('record.beforeInsert', (e) => {
      e.mutate({ stamped: true });
    });
    const result = await bus.runBefore('record.beforeInsert', {
      collection: 'x',
      data: { name: 'A' },
      userId: 'u',
    });
    expect(result.data).toEqual({ name: 'A', stamped: true });
  });

  it('onBefore abort() throws an AbortHookError-shaped error', async () => {
    const bus = mockEventBus();
    bus.onBefore('record.beforeInsert', (e) => e.abort('not allowed'));
    await expect(
      bus.runBefore('record.beforeInsert', { collection: 'x', data: {}, userId: 'u' }),
    ).rejects.toThrow('Aborted: not allowed');
  });

  it('on() returns an unsubscribe function', () => {
    const bus = mockEventBus();
    let count = 0;
    const off = bus.on('e', () => count++);
    bus.emit('e', null);
    off();
    bus.emit('e', null);
    expect(count).toBe(1);
  });
});

describe('mockServiceRegistry', () => {
  it('register + get round-trips', () => {
    const reg = mockServiceRegistry();
    reg.register('crm.lookup', async (id: string) => ({ id }));
    const fn = reg.get<(id: string) => Promise<any>>('crm.lookup');
    expect(fn).toBeDefined();
  });

  it('returns null for unknown services', () => {
    expect(mockServiceRegistry().get('missing')).toBeNull();
  });

  it('waitFor returns immediately if registered', async () => {
    const reg = mockServiceRegistry();
    reg.register('x', 42);
    expect(await reg.waitFor<number>('x')).toBe(42);
  });

  it('waitFor throws if not registered', async () => {
    await expect(mockServiceRegistry().waitFor('nope')).rejects.toThrow();
  });

  it('list returns all registered names', () => {
    const reg = mockServiceRegistry();
    reg.register('a', 1);
    reg.register('b', 2);
    expect(reg.list().sort()).toEqual(['a', 'b']);
  });
});

describe('mockAuth', () => {
  it('returns the default test user', async () => {
    const auth = mockAuth();
    const session = await auth.api.getSession();
    expect(session.user.id).toBe('test-user');
  });

  it('returns null session when explicitly anonymous', async () => {
    const auth = mockAuth({ user: null });
    expect(await auth.api.getSession()).toBeNull();
  });

  it('returns a custom user when supplied', async () => {
    const auth = mockAuth({ user: { id: 'alice', roles: ['admin'] } });
    const session = await auth.api.getSession();
    expect(session.user.id).toBe('alice');
    expect(session.user.roles).toEqual(['admin']);
  });
});

describe('createTestContext', () => {
  it('returns a usable ctx with all required fields', () => {
    const ctx = createTestContext();
    expect(typeof ctx.db).toBe('function'); // Proxy is callable
    expect(ctx.events).toBeDefined();
    expect(ctx.services).toBeDefined();
    expect(ctx.queryAlter).toBeDefined();
    expect(ctx.entityAccess).toBeDefined();
    expect(typeof ctx.registerPublicRoute).toBe('function');
  });

  it('respects per-test overrides', () => {
    const customDb = mockDb({ execute: [{ override: true }] });
    const ctx = createTestContext({ db: customDb });
    expect(ctx.db).toBe(customDb);
  });

  it('extra fields are merged onto the ctx', () => {
    const ctx = createTestContext({
      extra: { auth: { custom: true } as any },
    });
    expect((ctx.auth as any).custom).toBe(true);
  });

  it('checkPermission returns true by default', async () => {
    const ctx = createTestContext();
    expect(await ctx.checkPermission('u', 'r', 'a')).toBe(true);
  });
});

describe('createTestApp', () => {
  it('mounts a global-strategy extension at the root', async () => {
    const ext: ZveltioExtension = {
      name: 'demo',
      category: 'test',
      async register(app) {
        app.get('/hello', (c) => c.json({ msg: 'hi' }));
      },
    };
    const app = await createTestApp(ext);
    const res = await app.request('/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'hi' });
  });

  it('mounts a subapp-strategy extension at /ext/<name>', async () => {
    const ext: ZveltioExtension = {
      name: 'demo-sub',
      category: 'test',
      mountStrategy: 'subapp',
      async register(app) {
        app.get('/items', (c) => c.json({ items: [] }));
      },
    };
    const app = await createTestApp(ext);
    const res = await app.request('/ext/demo-sub/items');
    expect(res.status).toBe(200);
  });

  it('honors mountSubappAt=false to mount at root for cleaner test URLs', async () => {
    const ext: ZveltioExtension = {
      name: 'demo-flat',
      category: 'test',
      mountStrategy: 'subapp',
      async register(app) {
        app.get('/x', (c) => c.text('ok'));
      },
    };
    const app = await createTestApp(ext, { mountSubappAt: false });
    expect((await app.request('/x')).status).toBe(200);
  });

  it('passes the provided ctx through to register()', async () => {
    let receivedCtx: any = null;
    const ext: ZveltioExtension = {
      name: 'spy',
      category: 'test',
      async register(_app, ctx) {
        receivedCtx = ctx;
      },
    };
    const customCtx = createTestContext({
      auth: mockAuth({ user: { id: 'spy-user' } }),
    });
    await createTestApp(ext, { ctx: customCtx });
    expect(receivedCtx).toBe(customCtx);
  });
});

describe('end-to-end: extension with hooks + db + auth + Hono routes', () => {
  it('a realistic GET endpoint test', async () => {
    const db = mockDb({
      // Chain is method-only — table name 'zv_items' is the arg, not the chain.
      'selectFrom.selectAll.execute': [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ],
    });

    const ext: ZveltioExtension = {
      name: 'items',
      category: 'test',
      mountStrategy: 'subapp',
      async register(app, ctx) {
        app.get('/', async (c) => {
          const items = await (ctx.db as any).selectFrom('zv_items').selectAll().execute();
          return c.json({ items });
        });
      },
    };

    const ctx = createTestContext({ db });
    const app = await createTestApp(ext, { ctx, mountSubappAt: false });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].name).toBe('A');
  });
});

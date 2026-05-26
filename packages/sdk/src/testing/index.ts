/**
 * Testing helpers for Zveltio extensions (S4-06).
 *
 * Goal: give extension authors a one-liner to spin up a fake
 * `ExtensionContext` and a Hono test app, so unit tests run without a
 * real database or auth setup. For integration tests against a real
 * Postgres + engine, use Bun's `testcontainers` directly — this module
 * is the offline-fast path.
 *
 * Three primitives:
 *   - `createTestContext(overrides?)` — minimal `ExtensionContext` with
 *     no-op stubs for everything (db, auth, events, services,
 *     queryAlter, entityAccess, registerPublicRoute). Override per-test.
 *   - `createTestApp(extension, ctx?)` — runs `extension.register()`
 *     against a fresh Hono and returns the app, ready for `.request()`.
 *   - `mockDb(presets?)` — records query-builder calls; returns presets
 *     when an `.execute()` / `.executeTakeFirst()` lands. Enough to
 *     fake CRUD paths; falls back to empty arrays / undefined.
 */

import { Hono } from 'hono';
import type { ZveltioExtension, ExtensionContext } from '../extension/index.js';

// ─── Recording mock DB ─────────────────────────────────────────────────────

export interface MockCall {
  /** Method name chain, e.g. `'selectFrom.where.execute'`. */
  chain: string;
  /** Args of the terminal call. */
  args: unknown[];
}

export interface MockDbPresets {
  /**
   * Preset a return value for a specific chain. Match is by suffix —
   * `'selectFrom.zvd_users.execute'` matches the chain ending in that.
   * Use exact chains for precision.
   *
   * @example
   *   mockDb({
   *     'selectFrom.zvd_users.selectAll.execute': [{ id: '1', name: 'A' }],
   *     'selectFrom.zvd_users.executeTakeFirst': { id: '1', name: 'A' },
   *   })
   */
  [chain: string]: unknown;
}

export interface MockDb {
  /** Recorded calls, oldest first. Reset between tests. */
  readonly calls: MockCall[];
  /** Reset call history (presets stay). */
  reset(): void;
  /** Add or override a preset after construction. */
  preset(chain: string, value: unknown): void;
}

/**
 * Build a recording mock Kysely-shaped object. Any method chain is
 * accepted; the terminal `.execute()` / `.executeTakeFirst()` /
 * `.executeTakeFirstOrThrow()` returns a preset if matched, otherwise
 * an empty list (for execute) or undefined.
 */
export function mockDb(presets: MockDbPresets = {}): any & MockDb {
  const calls: MockCall[] = [];
  const presetMap = new Map<string, unknown>(Object.entries(presets));

  function buildChain(prefix: string[]): any {
    const proxy: any = new Proxy(() => {}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'calls') return calls;
        if (prop === 'reset')
          return () => {
            calls.length = 0;
          };
        if (prop === 'preset')
          return (chain: string, value: unknown) => {
            presetMap.set(chain, value);
          };
        if (prop === 'then') return undefined;
        // Build next link in the chain.
        return buildChain([...prefix, prop]);
      },
      // NOTE: synchronous apply. Terminal calls return a Promise; non-
      // terminal calls return the proxy itself so further chaining works
      // without awaiting. (Async apply would wrap every step in a Promise
      // and break `.selectFrom().selectAll().execute()` chains.)
      apply(_t, _this, args) {
        const chain = prefix.join('.');
        calls.push({ chain, args });
        const terminal = prefix[prefix.length - 1];

        const isTerminal =
          terminal === 'execute' ||
          terminal === 'executeTakeFirst' ||
          terminal === 'executeTakeFirstOrThrow';

        if (isTerminal) {
          const preset = matchPreset(chain, presetMap);
          if (preset !== undefined) {
            const resolved = typeof preset === 'function' ? preset(...args) : preset;
            return Promise.resolve(resolved);
          }
          if (terminal === 'execute') return Promise.resolve([]);
          if (terminal === 'executeTakeFirst') return Promise.resolve(undefined);
          // executeTakeFirstOrThrow with no preset → reject
          return Promise.reject(
            new Error(
              `mockDb: no preset for chain "${chain}" and executeTakeFirstOrThrow has no fallback`,
            ),
          );
        }

        // Non-terminal: keep chaining on the same proxy (its prefix is
        // unchanged; the next property access will extend via get()).
        return proxy;
      },
    });
    return proxy;
  }

  return buildChain([]) as any;
}

function matchPreset(chain: string, presets: Map<string, unknown>): unknown {
  // Exact match wins.
  if (presets.has(chain)) return presets.get(chain);
  // Suffix match: preset 'foo.execute' matches 'selectFrom.x.foo.execute'.
  for (const [key, val] of presets) {
    if (chain.endsWith(key)) return val;
  }
  return undefined;
}

// ─── Mock event bus ────────────────────────────────────────────────────────

export interface MockEventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: any) => void): () => void;
  onBefore(event: string, handler: (payload: any) => any): () => void;
  runBefore(event: string, seed: Record<string, unknown>): Promise<any>;
  /** Recorded emits, oldest first. */
  readonly emitted: Array<{ event: string; payload: unknown }>;
  /** Reset emit log. */
  reset(): void;
}

export function mockEventBus(): MockEventBus {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const listeners = new Map<string, Array<(p: any) => void>>();
  const beforeHandlers = new Map<string, Array<(p: any) => any>>();

  return {
    emit(event, payload) {
      emitted.push({ event, payload });
      for (const h of listeners.get(event) ?? []) h(payload);
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const cur = listeners.get(event);
        if (cur) {
          const idx = cur.indexOf(handler);
          if (idx >= 0) cur.splice(idx, 1);
        }
      };
    },
    onBefore(event, handler) {
      const list = beforeHandlers.get(event) ?? [];
      list.push(handler);
      beforeHandlers.set(event, list);
      return () => {
        const cur = beforeHandlers.get(event);
        if (cur) {
          const idx = cur.indexOf(handler);
          if (idx >= 0) cur.splice(idx, 1);
        }
      };
    },
    async runBefore(event, seed) {
      const payload: any = { ...seed };
      let aborted = false;
      let abortReason = '';
      payload.abort = (reason: string) => {
        aborted = true;
        abortReason = reason;
        const err: any = new Error(`Aborted: ${reason}`);
        err.name = 'AbortHookError';
        err.reason = reason;
        throw err;
      };
      payload.mutate = (patch: Record<string, unknown>) => {
        const key = event === 'record.beforeUpdate' ? 'patch' : 'data';
        payload[key] = { ...payload[key], ...patch };
      };
      for (const h of beforeHandlers.get(event) ?? []) {
        await h(payload);
      }
      return payload;
    },
    get emitted() {
      return emitted;
    },
    reset() {
      emitted.length = 0;
      listeners.clear();
      beforeHandlers.clear();
    },
  };
}

// ─── Mock service registry ─────────────────────────────────────────────────

export function mockServiceRegistry(): {
  register(name: string, value: unknown): void;
  unregister(name: string): void;
  get<T = unknown>(name: string): T | null;
  has(name: string): boolean;
  list(): string[];
  waitFor<T = unknown>(name: string, timeoutMs?: number): Promise<T>;
} {
  const services = new Map<string, unknown>();
  return {
    register(name, value) {
      services.set(name, value);
    },
    unregister(name) {
      services.delete(name);
    },
    get<T = unknown>(name: string) {
      return (services.get(name) as T | undefined) ?? null;
    },
    has(name) {
      return services.has(name);
    },
    list() {
      return [...services.keys()];
    },
    async waitFor<T = unknown>(name: string) {
      const v = services.get(name);
      if (v === undefined) throw new Error(`mockServiceRegistry: no service "${name}" registered`);
      return v as T;
    },
  };
}

// ─── Mock queryAlter / entityAccess scoped registries ──────────────────────

function mockQueryAlterScope() {
  const entries: Array<{ table: string; alter: any }> = [];
  return {
    register(def: { table: string; alter: any }) {
      entries.push(def);
    },
    list() {
      return entries.map((e) => ({ table: e.table }));
    },
    unregisterAll() {
      entries.length = 0;
    },
  };
}

function mockEntityAccessScope() {
  const entries: Array<{ table: string; check: any }> = [];
  return {
    register(def: { table: string; check: any }) {
      entries.push(def);
    },
    list() {
      return entries.map((e) => ({ table: e.table }));
    },
    unregisterAll() {
      entries.length = 0;
    },
  };
}

// ─── Mock auth ─────────────────────────────────────────────────────────────

export interface MockAuthOptions {
  /** If set, getSession returns `{ user: this }`. If null, getSession returns null. */
  user?: { id: string; email?: string; name?: string; roles?: string[] } | null;
}

export function mockAuth(opts: MockAuthOptions = {}): any {
  const user =
    opts.user === undefined ? { id: 'test-user', email: 'test@example.com', roles: [] } : opts.user;
  return {
    api: {
      async getSession() {
        return user === null ? null : { user };
      },
    },
  };
}

// ─── Composite: createTestContext ──────────────────────────────────────────

export interface CreateTestContextOptions {
  /** Override the mocked db. Default: `mockDb()`. */
  db?: any;
  /** Override the mocked auth. Default: signed-in test user. */
  auth?: any;
  /** Override the mocked event bus. Default: in-memory. */
  events?: MockEventBus;
  /** Provide additional fields. They go onto the returned ctx as-is. */
  extra?: Partial<ExtensionContext<any>>;
}

export function createTestContext(opts: CreateTestContextOptions = {}): ExtensionContext<any> {
  const db = opts.db ?? mockDb();
  const events = opts.events ?? mockEventBus();
  return {
    db,
    auth: opts.auth ?? mockAuth(),
    fieldTypeRegistry: {
      register: () => {},
      get: () => undefined,
      has: () => false,
      list: () => [],
      getAll: () => [],
      deserialize: (_t, v) => v,
      serialize: (_t, v) => v,
    },
    events: events as any,
    checkPermission: async () => true,
    getUserRoles: async () => ['admin'],
    DDLManager: {} as any,
    services: mockServiceRegistry() as any,
    queryAlter: mockQueryAlterScope() as any,
    entityAccess: mockEntityAccessScope() as any,
    registerPublicRoute: () => {},
    internals: {} as any,
    ...(opts.extra ?? {}),
  };
}

// ─── createTestApp ─────────────────────────────────────────────────────────

export interface CreateTestAppOptions {
  /** Override the context handed to register(). Default: `createTestContext()`. */
  ctx?: ExtensionContext<any>;
  /**
   * When the extension uses `mountStrategy: 'subapp'`, the engine normally
   * mounts the sub-app at `/ext/<name>`. For tests we replicate that so
   * `.request('/ext/<name>/...')` works. Pass `false` to skip the wrapper
   * and mount the sub-app at root for cleaner test URLs.
   */
  mountSubappAt?: string | false;
}

/**
 * Spin up a Hono test app with the extension's routes registered. Returns
 * the outer Hono so callers can use `.request(path, init)` for assertions.
 *
 * Honors the extension's `mountStrategy`. For `'subapp'`, the outer app
 * mounts the sub-app at `/ext/<extension.name>` by default — same shape
 * the engine produces in production.
 */
export async function createTestApp(
  extension: ZveltioExtension<any>,
  opts: CreateTestAppOptions = {},
): Promise<Hono> {
  const ctx = opts.ctx ?? createTestContext();
  const strategy = extension.mountStrategy ?? 'global';

  if (strategy === 'subapp') {
    const outer = new Hono();
    const sub = new Hono();
    await extension.register(sub, ctx);
    const mountPath =
      opts.mountSubappAt === false ? '/' : (opts.mountSubappAt ?? `/ext/${extension.name}`);
    outer.route(mountPath, sub);
    return outer;
  }

  const app = new Hono();
  await extension.register(app, ctx);
  return app;
}

// ─── Integration test helpers (Postgres) ─────────────────────────────────
//
// `withTestDb` + friends live in a separate module so the testcontainers
// dynamic import doesn't fan out on every consumer of `mockDb` /
// `createTestContext`. Re-exported here for the
// `import { withTestDb } from '@zveltio/sdk/testing'` ergonomics.

export {
  withTestDb,
  startTestDb,
  applyMigrationStrings,
  applyMigrationFiles,
  stopReusedTestDb,
  splitStatements,
  type TestDb,
  type WithTestDbOptions,
} from './with-test-db.js';

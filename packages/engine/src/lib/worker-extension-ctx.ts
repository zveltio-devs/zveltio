/**
 * The `ctx` a worker-isolated extension's `register()` receives (RFC
 * extension-runner, step 7): the surface an inline extension gets from
 * `buildRestrictedContext`, each member carried over the host bridge, and what
 * cannot cross refused by name the moment it is touched.
 *
 * Kept apart from the runtime, which takes over the console and the channel as
 * it loads, so the contract is unit-tested here and not only through a spawned
 * worker.
 */

import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { HostCallOp } from './worker-extension-protocol.js';

type Fn = (...args: unknown[]) => unknown;

export interface WorkerBridge {
  /** One statement through `db:query`: rows carrying `count`, or an error carrying `errno`. */
  query(sql: string, params: unknown[]): Promise<unknown[]>;
  /** `db.transaction()`: a savepoint in the request's transaction, named by the host. */
  savepoint(op: 'begin' | 'release' | 'rollback'): Promise<unknown>;
  /**
   * Runs a `db.transaction()` callback, so every statement made in it names the
   * one transaction — the request's, or outside a request one the host opens
   * (owner decision 4).
   */
  transaction<T>(run: () => Promise<T>): Promise<T>;
  host(op: HostCallOp, args: unknown[]): Promise<unknown>;
  serviceCall(name: string, args: unknown[]): Promise<unknown>;
  registerService(name: string, impl: Fn): void;
  /** Event listeners by the key the host delivers them under (`event:deliver`). */
  listeners: Map<string, Fn>;
  /** The extension's own `ctx.config`, resolved by the host. */
  config: unknown;
}

/** Members that act inside the engine process; none of them is a message. */
const OUT_OF_PROCESS = [
  'internals',
  'fieldTypeRegistry',
  'queryAlter',
  'entityAccess',
  'adminDb',
  'DDLManager',
  'registerPublicRoute',
  'onHealthCheck',
  'getUserRoles',
] as const;

export function refused(member: string, why = 'it runs inside the engine process'): Error {
  return new Error(
    `ctx.${member} is not available to a worker-isolated extension: ${why} ` +
      '(RFC extension-runner, step 7). Load the extension inline to use it.',
  );
}

/**
 * Kysely's own Postgres compiler and adapter, as `BunSqlDialect` uses them, over
 * a driver that sends each compiled statement across the bridge.
 */
function bridgeDialect({ query, savepoint }: WorkerBridge): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const rows = (await query(compiled.sql, [...compiled.parameters])) as unknown[] & {
        count?: number;
      };
      // What `numUpdatedRows` / `numDeletedRows` are built from, as inline.
      return typeof rows.count === 'number'
        ? { rows: rows as never[], numAffectedRows: BigInt(rows.count) }
        : { rows: rows as never[] };
    },
    async *streamQuery() {
      throw refused('db stream()', 'rows cross the bridge whole');
    },
  };
  // The request is already one transaction on the host (RFC step 8), so
  // `db.transaction()` nests in it as a savepoint, as it would inside an
  // inline request's transaction.
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction(_conn, settings) {
      if (settings.isolationLevel || settings.accessMode) {
        throw refused('db.transaction() settings', 'a savepoint cannot change them');
      }
      await savepoint('begin');
    },
    commitTransaction: () => savepoint('release').then(() => undefined),
    rollbackTransaction: () => savepoint('rollback').then(() => undefined),
    async releaseConnection() {},
    async destroy() {},
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
}

/**
 * `settled` resolves once every `events.on` made so far was accepted by the
 * host, and rejects with the first refusal: the runtime awaits it after
 * `register()`, so a subscription the host refuses fails the load, not a later
 * request.
 */
export function buildWorkerCtx(bridge: WorkerBridge): {
  ctx: Record<string, unknown>;
  settled: () => Promise<void>;
} {
  const kysely = new Kysely<unknown>({ dialect: bridgeDialect(bridge) });
  const transaction = kysely.transaction.bind(kysely);
  const db = Object.assign(kysely, {
    // The raw form worker extensions had before Kysely.
    query: (sql: string, ...params: unknown[]) => bridge.query(sql, params),
    // Every statement the callback makes, through `trx` or `db`, joins it.
    transaction: () => {
      const builder = transaction();
      const execute = builder.execute.bind(builder);
      return Object.assign(builder, {
        execute: ((callback) =>
          bridge.transaction(() => execute(callback))) as typeof builder.execute,
      });
    },
  });
  // Collected during `register()` only; a subscription made later reports itself.
  let pending: Promise<unknown>[] | null = [];
  let nextListener = 0;
  const ctx: Record<string, unknown> = {
    db,
    reqDb: () => db,
    config: bridge.config,
    auth: { api: { getSession: () => bridge.host('getSession', []) } },
    checkPermission: (userId: string, resource: string, action: string) =>
      bridge.host('checkPermission', [userId, resource, action]) as Promise<boolean>,
    events: {
      emit: (event: string, payload: unknown) => {
        bridge.host('emit', [event, payload, false]).catch((err: Error) => {
          console.error(`[worker] ctx.events.emit("${event}"): ${err.message}`);
        });
      },
      emitAsync: async (event: string, payload: unknown) => {
        await bridge.host('emit', [event, payload, true]);
      },
      on: (event: string, handler: Fn) => {
        const key = `l${++nextListener}`;
        bridge.listeners.set(key, handler);
        const accepted = bridge.host('on', [event, key]).catch((err: Error) => {
          bridge.listeners.delete(key);
          throw err;
        });
        if (pending) pending.push(accepted);
        accepted.catch((err: Error) => {
          if (!pending) console.error(`[worker] ctx.events.on("${event}"): ${err.message}`);
        });
        return () => {
          bridge.listeners.delete(key);
          bridge.host('off', [key]).catch(() => undefined);
        };
      },
      onBefore: () => {
        throw refused('events.onBefore', "a pre-write hook runs inside the write's transaction");
      },
    },
    services: {
      register: bridge.registerService,
      // The function, as inline: calling it is what crosses to the broker.
      get:
        (name: string) =>
        (...args: unknown[]) =>
          bridge.serviceCall(name, args),
    },
  };
  for (const member of OUT_OF_PROCESS) {
    // Not enumerable, so spreading the ctx does not trip it.
    Object.defineProperty(ctx, member, {
      get() {
        throw refused(member);
      },
    });
  }
  return {
    ctx,
    settled: async () => {
      const waiting = pending ?? [];
      pending = null;
      await Promise.all(waiting);
    },
  };
}

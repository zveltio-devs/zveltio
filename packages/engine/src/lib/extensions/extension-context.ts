/**
 * extension-context.ts
 *
 * Provides a RestrictedDb proxy that wraps the engine's Kysely Database.
 *
 * Access policy — one rule, applied to the SQL Postgres would receive, whether
 * a query builder, a raw `sql` template or `executeQuery` produced it (see
 * `checkedExecutor`): user-data collections (`zvd_*` minus the engine's own
 * metadata), the extension's own `zv_<extname>_*` namespace (slashes folded to
 * underscores), and the tables its migrations create or a grant names.
 * Everything else — `user`, `session`, `account`, the engine's `zv_*` and
 * `zvd_*` tables, the catalogue — is refused because it was never permitted.
 *
 * Hook interception (S2-02 follow-up): writes against `zvd_*` user tables
 * fire `record.beforeInsert` / `record.beforeUpdate` / `record.beforeDelete`
 * pre-write hooks the same way HTTP routes do, so business-logic hooks
 * registered by other extensions are not silently bypassed when a write
 * comes from `ctx.db.insertInto(...).execute()` instead of an HTTP route.
 *
 *   - Insert: hook always fires (cheap — we already have the data).
 *   - Update / Delete: hook fires when the WHERE clause is a clear
 *     single-row match by id (the common case). Bulk WHERE-clause writes
 *     skip the hook with a console warning — extensions doing maintenance
 *     work should be deliberate about it.
 */

import { type ConnectionProvider, QueryCreator } from 'kysely';
import type { Database } from '../../db/index.js';
import { registerEngineView } from '../engine-handle.js';
import { engineEvents, AbortHookError } from '../runtime/index.js';
import { joinedTransactionBuilder, withSavepoint } from '../savepoint.js';
import { getCurrentTenantTrx } from '../tenancy/index.js';
import { asExtensionDbRole, asExtensionDbRoleOnPool } from './ext-db-role.js';
import {
  assertWorkerSqlAllowed,
  WorkerSqlPolicyError,
  workerSqlEngineTables,
} from './worker-sql-policy.js';

/**
 * Every way to start a query on a Kysely handle — `selectFrom`, `with`,
 * `selectNoFrom`, `mergeInto`, `withSchema`… Read off Kysely itself, so an entry
 * point added upstream is guarded without anyone remembering to list it; a
 * hand-kept list of seven is what let `with` and `selectNoFrom` through.
 */
const QUERY_ENTRY_POINTS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(QueryCreator.prototype).filter((p) => p !== 'constructor'),
);

type RestrictedDatabase = Database;

/** Tables that extensions are allowed to fire write hooks against. We
 *  only fire hooks on `zvd_*` (user data) and the extension's own
 *  `zv_<extname>_*` namespace; system tables already throw before we get
 *  here. The restriction matters because firing `record.beforeInsert`
 *  on, say, `account` would surprise hook authors who only ever expect
 *  user-data tables. */
function shouldFireHooks(tableName: string): boolean {
  return tableName.startsWith('zvd_');
}

/**
 * Is this handle already inside a transaction?
 *
 * Kysely's Transaction carries `isTransaction`; the pool does not. Checking the
 * object rather than the ALS keeps this correct for a handle passed in
 * explicitly as well as one resolved per query.
 */
function isTenantTransaction(db: unknown): boolean {
  return Boolean((db as { isTransaction?: unknown } | null | undefined)?.isTransaction);
}

/**
 * Where an extension statement on `db` takes its role (lib/extensions/
 * ext-db-role.ts): a window on the transaction it runs in — the request's own
 * tenant transaction (`mirror` false: the plain role) or another one, such
 * as `ctx.adminDb.transaction()` (`mirror`: the twin with the reach of the role
 * in effect) — or, on the pool, a transaction of its own.
 */
type RoleScope = { trx: object; mirror: boolean } | { pool: Database };

function roleScope(db: Database): RoleScope {
  if (!isTenantTransaction(db)) return { pool: db };
  return { trx: db, mirror: db !== getCurrentTenantTrx() };
}

/**
 * The query creator `ctx.db.selectFrom()` & co. come from: Kysely's own, over
 * `checkedExecutor`, so every statement a builder runs is the compiled SQL the
 * raw path's analyzer reads.
 *
 * The guard used to read the table NAME passed to each entry point and wrap
 * the returned builder to read join names too. Everything else a builder can
 * express went to Postgres unread: a `sql` fragment in `.where()` or
 * `.select()`, `with()`, `selectNoFrom()`, `deleteFrom().using()`,
 * `updateTable().from()`. Measured on the old guard, an extension with no
 * grant read `"user"` and `session` through each of them. And the name check
 * admitted every `zvd_*`, including the engine's `zvd_permissions` that the raw
 * path refuses — two rules for one extension. Checking at the executor is one
 * rule, applied to the exact text Postgres receives, whatever built it.
 */
function checkedQueryCreator(
  target: Database,
  extName: string,
  allowedTables: Set<string> | undefined,
): QueryCreator<never> {
  return new QueryCreator({
    executor: checkedExecutor(target.getExecutor(), extName, allowedTables, roleScope(target)),
  });
}

/** Savepoint names for joined extension transactions; unique so nesting is plain. */
let savepointSeq = 0;

/** A compiled query as an executor receives it — only its text is read here. */
interface CompiledLike {
  sql: string;
}

/** Kysely's QueryExecutor, as far as this file touches it. */
interface ExecutorLike {
  executeQuery(query: CompiledLike, ...rest: unknown[]): Promise<unknown>;
  stream(query: CompiledLike, ...rest: unknown[]): AsyncIterableIterator<unknown>;
  withConnectionProvider(provider: ConnectionProvider): ExecutorLike;
}

/**
 * SQL from an extension, checked against its allowlist.
 *
 * The worker bridge's analyzer, given the inline extension's grants as well, so
 * both kinds of extension meet one rule. It used to cover raw SQL only, while
 * the builder had a table-name check of its own that admitted more; see
 * `checkedQueryCreator`.
 */
async function assertRawSqlAllowed(
  extName: string,
  text: string,
  allowedTables: Set<string> | undefined,
): Promise<void> {
  try {
    assertWorkerSqlAllowed(
      extName,
      text,
      await workerSqlEngineTables(),
      allowedTables ?? new Set(),
      'ctx.db',
    );
  } catch (err) {
    if (err instanceof WorkerSqlPolicyError) throw new ExtensionSecurityError(err.message);
    throw err;
  }
}

/**
 * The executor every extension statement runs through — raw SQL asks for it
 * with `ctx.db.getExecutor()`, builders carry it from `checkedQueryCreator` —
 * and every statement is checked first, as compiled, so plugins and `sql`
 * fragments are already in the text.
 *
 * `provideConnection` is refused: the connection it lends runs SQL with no
 * executor in between, and only Kysely's own `connection()` / `transaction()`
 * use it — on the real handle, never through here. Any method that returns
 * another executor (`withPlugin`, `withoutPlugins`, …) gets the same wrapper.
 *
 * `scope`: where each statement takes the extension role (`roleScope`) — the
 * layer that holds when the analyzer above it is wrong.
 */
function checkedExecutor<T extends object>(
  executor: T,
  extName: string,
  allowedTables: Set<string> | undefined,
  scope: RoleScope,
): T {
  const real = executor as unknown as ExecutorLike;
  const asRole = <R>(run: (ex: ExecutorLike) => Promise<R>): Promise<R> =>
    'pool' in scope
      ? asExtensionDbRoleOnPool(extName, scope.pool, (on) =>
          run(on ? real.withConnectionProvider(on) : real),
        )
      : asExtensionDbRole(extName, scope.trx, real as never, () => run(real), scope.mirror);
  return new Proxy(executor, {
    get(target, prop) {
      if (prop === 'executeQuery') {
        return async (query: CompiledLike, ...rest: unknown[]) => {
          await assertRawSqlAllowed(extName, query.sql, allowedTables);
          return asRole((ex) => ex.executeQuery(query, ...rest));
        };
      }
      if (prop === 'stream') {
        // Drained inside the role window: a cursor left open past the restore
        // would fetch its later rows as whatever role came back.
        return async function* (query: CompiledLike, ...rest: unknown[]) {
          await assertRawSqlAllowed(extName, query.sql, allowedTables);
          const chunks = await asRole(async (ex) => {
            const out: unknown[] = [];
            for await (const c of ex.stream(query, ...rest)) out.push(c);
            return out;
          });
          yield* chunks;
        };
      }
      if (prop === 'provideConnection') {
        return () => {
          throw new ExtensionSecurityError(
            `Extension "${extName}" asked ctx.db's executor for a connection. That ` +
              `connection runs SQL past the table allowlist; use ctx.db.transaction().`,
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return typeof (out as Partial<ExecutorLike> | null)?.executeQuery === 'function'
          ? checkedExecutor(out as object, extName, allowedTables, scope)
          : out;
      };
    },
  });
}

/**
 * Members of a Kysely handle that hand back a handle — or a connection — this
 * proxy cannot see into, so raw SQL run on it would skip `checkedExecutor`.
 * None is used by any first-party extension; `transaction()` is the supported
 * way to group statements, and it hands its callback a guarded handle.
 */
const UNGUARDED_HANDLES = new Set([
  'connection',
  'startTransaction',
  'withPlugin',
  'withoutPlugins',
  'withTables',
  'schema',
  'introspection',
]);

export function createRestrictedDb(
  dbOrResolver: Database | (() => Database),
  extName: string,
  allowedTables?: Set<string>,
  /**
   * Engine-only: the view `engineHandle()` returns, for SQL the ENGINE writes on
   * a handle an extension passed in: nothing it runs is checked. Engine code
   * applies it to its own statements only (see `engine-handle.ts`). Extensions
   * never receive this.
   */
  trustRawSql = false,
): RestrictedDatabase {
  // H-12: accept a RESOLVER so `ctx.db` can bind to the CURRENT request/job
  // tenant transaction (resolved per query via the ALS) rather than a single
  // fixed handle captured at extension-load time. A plain Database still works
  // (e.g. the explicit cross-tenant `ctx.adminDb`).
  const resolveDb: () => Database =
    typeof dbOrResolver === 'function' ? (dbOrResolver as () => Database) : () => dbOrResolver;
  // An extension named "ai" owns `zv_ai_*`. An extension named "compliance/ro/saft"
  // owns `zv_compliance_ro_saft_*` (slashes normalized to underscores).
  /** The same guard over a handle this one opened (a transaction). */
  const guarded = (db: Database): Database => createRestrictedDb(db, extName, allowedTables);

  // Proxy over an empty object; every property access resolves the real
  // (possibly request-scoped) Database on demand via `resolveDb()`.
  const handle = new Proxy({} as Database, {
    get(_dummy, prop: string | symbol) {
      const target = resolveDb();

      if (!trustRawSql && typeof prop === 'string') {
        const checked = () =>
          checkedExecutor(target.getExecutor(), extName, allowedTables, roleScope(target));
        if (prop === 'getExecutor') return checked;
        if (prop === 'executeQuery') {
          // Kysely's own `executeQuery` is `getExecutor().executeQuery(…)`; the
          // checked executor is that, with the analyzer and the role in front.
          return async (query: unknown, ...rest: unknown[]) => {
            const compiled = (
              typeof (query as { compile?: unknown }).compile === 'function'
                ? (query as { compile(): CompiledLike }).compile()
                : query
            ) as CompiledLike;
            return checked().executeQuery(compiled as never, ...(rest as []));
          };
        }
        if (UNGUARDED_HANDLES.has(prop)) {
          throw new ExtensionSecurityError(
            `Extension "${extName}" used ctx.db.${prop}, which returns a handle the table ` +
              `allowlist does not cover. Use ctx.db (and ctx.db.transaction()) directly.`,
          );
        }
      }

      // `ctx.db.transaction()` JOINS the request's transaction rather than
      // nesting, which Kysely refuses outright with "calling the transaction
      // method for a Transaction is not supported".
      //
      // `ctx.db` resolves the tenant transaction the middleware opened, so an
      // extension that wraps its own work in a transaction — the correct
      // instinct for a multi-statement operation — got that error instead. The
      // same fix was made for core routes; extensions take a different proxy
      // and were left out of it.
      //
      // Found through `compliance/gdpr`: the right-to-erasure route wraps its
      // deletes in a transaction, so account erasure failed on EVERY install,
      // reporting "referential integrity" — a guess at the cause that named
      // the wrong thing entirely.
      //
      // Joining is also the correct semantics: the extension's work commits
      // with the request that triggered it.
      //
      // But inside a SAVEPOINT, so a throw still undoes the block. A plain join
      // did not: the handler's error became a 500 response, the request's
      // transaction committed normally, and every write before the throw stayed.
      // Measured on SCIM: a PatchOp renaming the god and deactivating them was
      // refused, and the rename and the "inactive" flag were both kept.
      if (prop === 'transaction' && isTenantTransaction(target)) {
        return () =>
          joinedTransactionBuilder(
            target,
            // The guarded handle, not `target`: the callback is extension code,
            // and the bare transaction it used to get answered both
            // `trx.selectFrom('session')` and raw SQL on any table. The engine's
            // view keeps the bare transaction it always had.
            trustRawSql ? target : guarded(target),
            (body) =>
              withSavepoint(target, `zv_ext_trx_${++savepointSeq}`, body, (err) => {
                throw err;
              }),
          );
      }

      // Outside a tenant transaction (the pool — boot, `ctx.adminDb`), Kysely's
      // own transaction runs, and its callback gets the same guard.
      if (prop === 'transaction' && !trustRawSql) {
        type TrxBuilder = {
          setIsolationLevel(l: unknown): TrxBuilder;
          setAccessMode(m: unknown): TrxBuilder;
          execute<T>(fn: (t: Database) => Promise<T>): Promise<T>;
        };
        const wrap = (b: TrxBuilder): TrxBuilder => ({
          setIsolationLevel: (l) => wrap(b.setIsolationLevel(l)),
          setAccessMode: (m) => wrap(b.setAccessMode(m)),
          execute: (fn) => b.execute((trx) => fn(guarded(trx))),
        });
        return () => wrap(target.transaction() as unknown as TrxBuilder);
      }

      if (!trustRawSql && typeof prop === 'string' && QUERY_ENTRY_POINTS.has(prop)) {
        const creator = checkedQueryCreator(target, extName, allowedTables);
        return (...args: unknown[]) => {
          // Writes to a collection run the field pipeline and the record hooks,
          // as the data API does; the builder they replay is the checked one.
          const table = typeof args[0] === 'string' ? args[0].split(/\s+/)[0]! : '';
          if (shouldFireHooks(table)) {
            if (prop === 'insertInto') return wrapInsertForHooks(creator, target, table, extName);
            if (prop === 'updateTable') return wrapUpdateForHooks(creator, target, table, extName);
            if (prop === 'deleteFrom' && engineEvents.preHookCount('record.beforeDelete') > 0) {
              return wrapDeleteForHooks(creator, table, extName);
            }
          }
          return (creator as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!(
            ...args,
          );
        };
      }

      // `unknown`, not `any` — see the same trap in `createRequestScopedDb`.
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];

      if (typeof value === 'function') {
        const bound = value.bind(target);

        // `bind` returns a bare function and carries none of the original's own
        // properties. Invisible for an ordinary method, fatal for a callable
        // object with methods hanging off it — which is exactly what Kysely's
        // `db.fn` is: callable, and carrying `count`, `sum`, `avg`, `max`,
        // `min`, `agg`, `coalesce` and the rest as own properties.
        //
        // So `ctx.db.fn` came back a function and `ctx.db.fn.count` came back
        // undefined, and any extension aggregating through the proxy threw
        // "db.fn.count is not a function" and answered 500. `GET /ext/ai/usage`
        // did it on every install. A comment in `ai/routes/zveltio-ai.ts`
        // records someone meeting the same wall and rewriting that one query —
        // which fixed the instance and left the cause untouched, with six more
        // call sites across `ai` and `compliance/ro/procurement` still on it.
        //
        // `eb.fn` inside a `select(eb => …)` callback was always fine: that
        // builder comes from Kysely and never passes through here, which is why
        // the failure looked arbitrary from the extension side.
        //
        // `Object.keys` on a plain function is empty — length, name and
        // prototype are non-enumerable — so the ordinary path pays one empty
        // array and nothing else.
        if (Object.keys(value).length > 0) Object.assign(bound, value);
        return bound;
      }

      return value;
    },
  }) as RestrictedDatabase;

  if (!trustRawSql) {
    registerEngineView(handle, () =>
      createRestrictedDb(dbOrResolver, extName, allowedTables, true),
    );
  }
  return handle;
}

/**
 * A `ctx.adminDb` stand-in for extensions that did NOT declare the `db:admin`
 * capability (H-12). Any query method throws, so the cross-tenant escape hatch
 * is unavailable unless explicitly requested in the manifest `permissions`.
 */
export function createDeniedAdminDb(extName: string): RestrictedDatabase {
  return new Proxy({} as Database, {
    get(_dummy, prop: string | symbol) {
      if (typeof prop === 'string' && QUERY_ENTRY_POINTS.has(prop)) {
        return () => {
          throw new ExtensionSecurityError(
            `Extension "${extName}" used ctx.adminDb without declaring the "db:admin" ` +
              `capability. adminDb grants CROSS-TENANT database access; add "db:admin" to the ` +
              `manifest "permissions" to enable it (it is surfaced at review + install time).`,
          );
        };
      }
      return undefined;
    },
  }) as RestrictedDatabase;
}

// ── Insert hook interception ───────────────────────────────────────────────
//
// Strategy: record every chain method call. At `.execute*()` time, run the
// hook, then replay the entire chain against a fresh `insertInto` builder
// (possibly with mutated `values` data). The replay is necessary because
// Kysely builders are immutable — there's no way to mutate `values` data
// in place.

interface ChainCall {
  method: string;
  args: unknown[];
}

const TERMINAL_METHODS = new Set(['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow']);

/**
 * A Kysely builder addressed by a method name only known at runtime.
 *
 * Through `unknown` rather than `any` so the escape is named in one place and
 * nothing else about the builder silently loses its types.
 */
type DynamicBuilder = Record<string, (...args: unknown[]) => never>;
function asDynamic(builder: unknown): DynamicBuilder {
  return builder as DynamicBuilder;
}

/**
 * Run a write's payload through the engine's field pipeline.
 *
 * `ctx.db.insertInto('zvd_x').values({...})` reached Postgres untouched, so a
 * field type's `deserialize` never ran and `encrypted: true` was ignored. The
 * same value written through POST /api/data was hashed and encrypted; written
 * by an extension it was stored verbatim. Nothing above the storage layer
 * showed a difference — the field renders the same either way, and only the
 * bytes on disk differ.
 *
 * That is the gap import and sync had before they were routed through
 * `processInput`, and it is the same fix. Applying it in the PROXY rather than
 * offering extensions a helper to call is the point: every extension may write
 * `zvd_*`, so a helper is forty-four chances to forget, and this campaign has
 * already found six rules that went missing in exactly that way.
 *
 * Runs before hooks, matching the HTTP handlers (processInput, then
 * `record.beforeInsert`). Throws on a validation error rather than writing
 * anyway — an extension putting data in that the collection says is invalid is
 * the thing worth interrupting, and a thrown error is visible where silent
 * acceptance is not.
 *
 * `partial` is true for updates: a `set()` carries only the columns being
 * changed, so required-field enforcement must not fire on the absent ones.
 *
 * Collections are metadata-cached, so the steady state costs no query.
 */
async function runFieldPipeline(
  db: Database,
  table: string,
  extName: string,
  data: Record<string, unknown>,
  partial: boolean,
): Promise<Record<string, unknown>> {
  const { DDLManager, processInput, normalizeFields } = await import('../data/index.js');
  const collection = table.replace(/^zvd_/, '');
  const collectionDef = await DDLManager.getCollection(db, collection).catch(() => null);
  // No collection definition means no field metadata to apply — the table is
  // not a user collection (or is being written during its own creation).
  if (!collectionDef) return data;

  const { errors, processed } = await processInput(data, collectionDef, partial);
  if (errors.length > 0) {
    throw new ExtensionSecurityError(
      `Extension "${extName}" wrote invalid data to "${table}": ${errors.join('; ')}. ` +
        `Extension writes go through the same field pipeline as the data API — ` +
        `validation, type deserialization and field encryption — so what an ` +
        `extension stores matches what every other path stores.`,
    );
  }

  // `processed` holds ONLY the collection's declared fields — that is what the
  // HTTP handlers want, because they add `id`, `created_by` and the timestamps
  // themselves afterwards. An extension puts them in the same object, so
  // returning `processed` alone would drop the primary key on the floor and
  // the insert would write a row nobody asked for.
  //
  // So: keep every key that is NOT a declared field, and let the pipeline's
  // output win for the ones that are. Fields the pipeline deliberately omitted
  // — virtual columns, and in partial mode anything the caller did not send —
  // stay omitted, which is the point of it having omitted them.
  const declared = new Set(normalizeFields(collectionDef).map((f) => f.name));
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!declared.has(k)) passthrough[k] = v;
  }
  return { ...passthrough, ...processed };
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
function wrapInsertForHooks(db: any, target: Database, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') {
          // Pass through Symbol-keyed properties (e.g. Symbol.iterator on
          // returned array proxies). They never appear on builders we care
          // about, but being defensive keeps the wrapper transparent.
          return Reflect.get(t, prop);
        }

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            // Pull current `values()` arg from the recorded chain.
            const valuesIdx = chainCalls.findIndex((c) => c.method === 'values');
            const originalData =
              valuesIdx >= 0 ? (chainCalls[valuesIdx].args[0] as Record<string, unknown>) : {};

            try {
              const shaped = await runFieldPipeline(target, table, extName, originalData, false);
              const payload = await engineEvents.runBefore('record.beforeInsert', {
                collection: table,
                data: shaped,
                userId: `system:${extName}`,
              });
              // Rebuild the chain with the (possibly mutated) data.
              let q = db.insertInto(table);
              for (let i = 0; i < chainCalls.length; i++) {
                const call = chainCalls[i];
                if (i === valuesIdx) q = q.values(payload.data);
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                else q = (q as any)[call.method](...call.args);
              }
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
              return await (q as any)[prop](...termArgs);
            } catch (err) {
              if (err instanceof AbortHookError) throw err;
              throw err;
            }
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.insertInto(table));
}

// ── Update hook interception ───────────────────────────────────────────────
//
// Only handles the single-row case: `db.updateTable('zvd_x').set({...})
// .where('id', '=', someId).execute()`. We detect the `id` from the WHERE
// chain. If the WHERE is more complex than that, we skip the hook (with a
// console warning the first time it happens for a given table+ext).

const _bulkWriteWarned = new Set<string>();

function warnBulkSkip(kind: 'update' | 'delete', table: string, extName: string): void {
  const key = `${kind}:${table}:${extName}`;
  if (_bulkWriteWarned.has(key)) return;
  _bulkWriteWarned.add(key);
  console.warn(
    `[hook-intercept] Extension "${extName}" issued a bulk ${kind} on "${table}". ` +
      `record.before${kind === 'update' ? 'Update' : 'Delete'} hooks ` +
      `only fire on single-row WHERE-by-id writes; this one will skip hooks. ` +
      `Pre-fetch ids and loop if you need per-row hook semantics.`,
  );
}

/** Try to extract a single id from chain WHERE calls. Returns `null` if
 *  the WHERE clause is anything more complex than `where('id', '=', X)`. */
function extractSingleId(chainCalls: ChainCall[]): string | null {
  const whereCalls = chainCalls.filter((c) => c.method === 'where');
  if (whereCalls.length !== 1) return null;
  const args = whereCalls[0].args;
  if (args.length !== 3) return null;
  if (args[0] !== 'id' || args[1] !== '=') return null;
  const v = args[2];
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  return String(v);
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
function wrapUpdateForHooks(db: any, target: Database, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop);

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            const id = extractSingleId(chainCalls);
            const setIdx = chainCalls.findIndex((c) => c.method === 'set');
            const originalPatch =
              setIdx >= 0 ? (chainCalls[setIdx].args[0] as Record<string, unknown>) : {};

            if (!id) {
              // Bulk update: hooks need a row to describe and there isn't one,
              // but the field pipeline only needs the patch — so the columns
              // still get deserialized and encrypted even though the hook is
              // skipped. Storing plaintext because the WHERE was too broad
              // would be an odd rule.
              warnBulkSkip('update', table, extName);
              if (setIdx < 0) return await asDynamic(t)[prop](...termArgs);

              const shapedBulk = await runFieldPipeline(
                target,
                table,
                extName,
                originalPatch,
                true,
              );
              let qb = db.updateTable(table);
              for (let i = 0; i < chainCalls.length; i++) {
                const call = chainCalls[i];
                if (i === setIdx) qb = qb.set(shapedBulk);
                else qb = asDynamic(qb)[call.method](...call.args);
              }
              return await asDynamic(qb)[prop](...termArgs);
            }
            // Single-row update: fire hook with `before` snapshot.
            const before = (await db
              .selectFrom(table)
              .selectAll()
              .where('id', '=', id)
              .executeTakeFirst()
              .catch(() => undefined)) as Record<string, unknown> | undefined;
            const shaped = await runFieldPipeline(target, table, extName, originalPatch, true);
            const payload = await engineEvents.runBefore('record.beforeUpdate', {
              collection: table,
              id,
              before: before ?? {},
              patch: shaped,
              userId: `system:${extName}`,
            });
            // Replay chain with mutated patch.
            let q = db.updateTable(table);
            for (let i = 0; i < chainCalls.length; i++) {
              const call = chainCalls[i];
              if (i === setIdx) q = q.set(payload.patch);
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
              else q = (q as any)[call.method](...call.args);
            }
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
            return await (q as any)[prop](...termArgs);
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.updateTable(table));
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
function wrapDeleteForHooks(db: any, table: string, extName: string): any {
  const chainCalls: ChainCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function makeStage(realBuilder: any): any {
    return new Proxy(realBuilder, {
      get(t, prop: string | symbol) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop);

        if (TERMINAL_METHODS.has(prop)) {
          return async (...termArgs: unknown[]) => {
            const id = extractSingleId(chainCalls);
            if (!id) {
              warnBulkSkip('delete', table, extName);
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
              return await (t as any)[prop](...termArgs);
            }
            const record = (await db
              .selectFrom(table)
              .selectAll()
              .where('id', '=', id)
              .executeTakeFirst()
              .catch(() => undefined)) as Record<string, unknown> | undefined;
            await engineEvents.runBefore('record.beforeDelete', {
              collection: table,
              id,
              record: record ?? {},
              userId: `system:${extName}`,
            });
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
            return await (t as any)[prop](...termArgs);
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const val = (t as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            chainCalls.push({ method: prop, args });
            return makeStage(val.call(t, ...args));
          };
        }
        return val;
      },
    });
  }

  return makeStage(db.deleteFrom(table));
}

export class ExtensionSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionSecurityError';
  }
}

// Internal helpers exposed for tests only.
export const _internalForTests = { extractSingleId, shouldFireHooks };

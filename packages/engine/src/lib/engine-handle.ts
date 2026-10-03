/**
 * The engine's view of a database handle an extension passed in.
 *
 * `ctx.db` checks every statement an extension issues against the
 * extension's table allowlist (see `createRestrictedDb`). Engine helpers handed
 * to extensions — `ctx.DDLManager`, `ctx.internals.dynamicInsert` — receive that
 * same handle and run their OWN raw SQL on it: `information_schema`,
 * `zvd_collections`, trigger functions. That SQL is engine code, not extension
 * code, so it is the engine's to vouch for, statement by statement.
 *
 * `engineHandle(db)` returns a view of an extension handle whose SQL is not
 * checked, raw or built. Only engine code can reach it — the
 * registry is a module-private WeakMap, so nothing an extension holds names it —
 * and it is applied where the engine's own SQL is issued, never to a whole
 * helper, because a helper like `dynamicInsert` also runs SQL whose table the
 * EXTENSION chose, and that statement must stay checked.
 */
const views = new WeakMap<object, () => unknown>();

/** Called by `createRestrictedDb` for every handle it builds. */
export function registerEngineView(handle: object, view: () => unknown): void {
  views.set(handle, view);
}

/** The unchecked-raw view of an extension handle; any other value comes back unchanged. */
export function engineHandle<T>(db: T): T {
  const view = typeof db === 'object' && db !== null ? views.get(db) : undefined;
  return view ? (view() as T) : db;
}

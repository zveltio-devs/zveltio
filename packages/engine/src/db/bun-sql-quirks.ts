/**
 * What the rest of the engine has to know about the `Bun.SQL` driver.
 *
 * `Bun.SQL` is young, and some of its behaviour leaks past the Kysely dialect
 * into ordinary code. Each such quirk is answered here, once, with a test in
 * `tests/unit/bun-sql-quirks.test.ts`, so that when upstream fixes one the
 * workaround is removed in one place rather than hunted down across the tree.
 *
 * The driver's own defects — no timeout on `reserve()` or on a queued query,
 * `close()` hanging on a dead backend, cached plans surviving a migration —
 * are handled inside `bun-sql-dialect.ts`, where the driver is called. This
 * module holds only what callers of the database see.
 */

/**
 * The SQLSTATE of a database error, or `''` when the error carries none.
 *
 * `Bun.SQL` puts the generic `ERR_POSTGRES_SERVER_ERROR` in `code` and the real
 * SQLSTATE in `errno`; node-postgres puts it in `code`. Comparing `code` with
 * '23505' was dead code on Bun more than once, so every reader asks here.
 * `code` is read only when there is no `errno`, and only a real SQLSTATE —
 * five letters or digits — is returned, so a Node system error (`errno` -32,
 * `code` 'EPIPE') does not read as one.
 */
export function sqlState(err: unknown): string {
  const e = err as { errno?: unknown; code?: unknown } | null | undefined;
  const raw = String(e?.errno ?? e?.code ?? '');
  return /^[0-9A-Z]{5}$/.test(raw) ? raw : '';
}

/**
 * Whether an error that escaped every `await` is a dropped connection the
 * engine survives, rather than a bug that must stop the process.
 *
 * - `ERR_POSTGRES_CONNECTION_CLOSED` / "Connection closed": the pool races its
 *   idle timeout against a transaction's release; the connection is already
 *   gone and there is nothing to roll back.
 * - "must be a PostgresSQLConnection": `Bun.SQL`'s native transaction handler
 *   throws synchronously when the socket dies mid-transaction, so the throw
 *   lands as an uncaught exception, outside any promise.
 * - `ECONNRESET` / `EPIPE`: a WebSocket peer went away.
 */
export function isRecoverableDbError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null | undefined;
  const code = e?.code;
  const msg = e?.message ?? '';
  return (
    code === 'ERR_POSTGRES_CONNECTION_CLOSED' ||
    /Connection closed/i.test(msg) ||
    /must be a PostgresSQLConnection/i.test(msg) ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  );
}

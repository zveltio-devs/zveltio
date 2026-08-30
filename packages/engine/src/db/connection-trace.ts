/**
 * Counts pool connections taken while a request already holds one.
 *
 * A request that opens the tenant transaction has a connection. If it then asks
 * the pool for another — a permission lookup, an audit write, a route reaching
 * for the bare `db` — it needs two AT ONCE. At `c = DB_POOL_MAX` every
 * connection is held by such a transaction and the second can never arrive, so
 * the instance stops rather than slows. That is the measured shape of the
 * ceiling: at pool 10 and again at 25, `idle in transaction × pool, active × 1`.
 *
 * The obvious probe — run with `DB_POOL_MAX=1` and see which routes hang — LIES.
 * It reports routes that are perfectly well behaved, because the engine's own
 * background writes hold the single connection between requests. A gate built
 * on it would name innocent routes and miss the guilty ones the moment the
 * background went quiet. So the property is counted directly instead.
 *
 * The wrapper is always installed and the counter is gated instead. Installing
 * it conditionally was tried first and made the whole thing order-dependent: the
 * decision is taken when the pool is built, so a test that turned tracing on
 * afterwards measured nothing and reported every route clean. One function call
 * per connection acquisition is not a cost worth that.
 */

let _tracing = process.env.ZVELTIO_TRACE_CONNECTIONS === '1';
let _inTransaction = false;
let _extra = 0;

/** Whether tracing is on. Read once per connection acquisition, so it is cheap. */
export function connectionTracingEnabled(): boolean {
  return _tracing;
}

/** Test seam — turn tracing on without an environment variable. */
export function _setConnectionTracing(on: boolean): void {
  _tracing = on;
}

/** Called by the driver wrapper. Counts only what is taken while one is held. */
export function noteConnectionAcquired(): void {
  if (_tracing && _inTransaction) _extra++;
}

/** Called by the tenant middleware around the request transaction. */
export function beginTracedTransaction(): void {
  if (!_tracing) return;
  _inTransaction = true;
  _extra = 0;
}

/** Extra connections this request asked for. Ends the traced window. */
export function endTracedTransaction(): number {
  if (!_tracing) return 0;
  _inTransaction = false;
  const extra = _extra;
  // Reset here, not only in `begin`. Without it the count of one request
  // survived into the next read, so a clean request inherited a dirty number —
  // found by the planted case, which asked twice and got the same answer both
  // times.
  _extra = 0;
  return extra;
}

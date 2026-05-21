/**
 * Tiny optimistic-update helper. Wraps a mutation so the caller sees:
 *
 *   1. Local state patched immediately (no network wait).
 *   2. Server call awaited in the background.
 *   3. On success, optionally merge the server's authoritative response.
 *   4. On failure, roll the local state back + surface the error.
 *
 * Designed to be readable at the call site. Example for a row delete:
 *
 *   await withOptimistic({
 *     apply: () => { records = records.filter((r) => r.id !== id); },
 *     rollback: (prev) => { records = prev; },
 *     snapshot: records,
 *     commit: () => dataApi.delete(collection, id),
 *     onError: (err) => toast.error(err.message),
 *   });
 *
 * Why a helper instead of inlining the try/catch: every page made the
 * same mistake — patched state, awaited the network, then forgot to roll
 * back on 4xx/5xx. Three places had silent stale UI as a result. A
 * single helper makes "you forgot the rollback" impossible.
 */

export interface OptimisticOptions<T, R = unknown> {
  /** Patch local state immediately. Called once, synchronously. */
  apply: () => void;
  /** Restore local state from the snapshot. Called once on failure. */
  rollback: (snapshot: T) => void;
  /** Snapshot of local state captured BEFORE `apply` runs. */
  snapshot: T;
  /** Network call. Returns the server response (or void). */
  commit: () => Promise<R>;
  /** Called with the result when the network call succeeds. Optional. */
  onSuccess?: (result: R) => void;
  /** Called with the thrown error when the network call fails. */
  onError?: (err: Error) => void;
}

export async function withOptimistic<T, R = unknown>(
  opts: OptimisticOptions<T, R>,
): Promise<R | undefined> {
  // Capture the snapshot reference at the call site — the caller already
  // built it (often by structuredClone or a shallow copy). Don't take
  // ownership of cloning here; the right granularity is page-specific.
  const snap = opts.snapshot;
  opts.apply();
  try {
    const result = await opts.commit();
    opts.onSuccess?.(result);
    return result;
  } catch (err) {
    opts.rollback(snap);
    const e = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(e);
    return undefined;
  }
}

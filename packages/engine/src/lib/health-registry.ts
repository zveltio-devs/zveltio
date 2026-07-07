/**
 * Deep-health subsystem registry (TECHNICAL-GAPS 1.4).
 *
 * Core subsystems (db, migrations, cache, storage, queue, realtime, extensions)
 * are assembled in `routes/health.ts` because they need the request-scoped `db`.
 * THIS registry holds checks contributed by extensions via `ctx.onHealthCheck`,
 * so `/api/health/deep` and `/api/health/:subsystem` surface them too.
 *
 * Extension checks are namespaced `ext:<extName>:<name>` and cleared on reload
 * so a re-registered extension never leaves a stale check pointing at old code.
 */

export interface HealthResult {
  ok: boolean;
  durationMs?: number;
  error?: string;
  /** Optional structured detail (queue depth, backend name, …). */
  detail?: Record<string, unknown>;
}

export interface HealthCheck {
  name: string;
  /** A failing critical check makes the whole engine unhealthy (503). */
  critical: boolean;
  run: () => Promise<HealthResult> | HealthResult;
}

const registry = new Map<string, HealthCheck>();

export function registerHealthCheck(
  name: string,
  run: HealthCheck['run'],
  opts: { critical?: boolean } = {},
): void {
  registry.set(name, { name, critical: opts.critical ?? false, run });
}

export function unregisterHealthCheck(name: string): void {
  registry.delete(name);
}

/** Drop every check an extension registered (namespaced `ext:<extName>:`). */
export function clearExtensionHealthChecks(extName: string): void {
  const prefix = `ext:${extName}:`;
  for (const key of registry.keys()) {
    if (key.startsWith(prefix)) registry.delete(key);
  }
}

export function listHealthChecks(): HealthCheck[] {
  return [...registry.values()];
}

export function getHealthCheck(name: string): HealthCheck | undefined {
  return registry.get(name);
}

/** Run a check with timing + fail-closed error capture. */
export async function runHealthCheck(check: HealthCheck): Promise<HealthResult> {
  const t0 = performance.now();
  try {
    const r = await check.run();
    return { durationMs: +(performance.now() - t0).toFixed(1), ...r };
  } catch (err) {
    return {
      ok: false,
      durationMs: +(performance.now() - t0).toFixed(1),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

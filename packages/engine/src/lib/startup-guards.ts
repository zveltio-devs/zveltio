/**
 * Configuration that must not reach production.
 *
 * Every escape hatch in this engine was added for a good local reason — a
 * developer needs to call an extension route without a session, an operator
 * needs to bring an instance up while an auth provider is down. The failure
 * mode is not the hatch; it is the hatch that was opened during an incident at
 * 3am and never closed, in a process nobody restarts and a log nobody reads.
 *
 * So the checks live here, together, as data: one pure function that takes the
 * environment and returns what is wrong with it. A guard that can only be
 * exercised by starting a production engine against a broken configuration is a
 * guard nothing tests, which is how this codebase has produced regressions
 * before.
 */

export interface ProductionGuardViolation {
  /** The variable at fault, so the operator can act without reading source. */
  variable: string;
  /** What is unsafe, and what to do instead. */
  message: string;
}

/**
 * Check an environment for settings that disable a security control.
 *
 * Returns every violation rather than the first: an operator who has set two
 * hatches should learn that in one restart, not two.
 */
export function productionGuardViolations(
  env: Record<string, string | undefined>,
): ProductionGuardViolation[] {
  if (env.NODE_ENV !== 'production') return [];

  const violations: ProductionGuardViolation[] = [];

  // ZVELTIO_EXT_AUTH_GATE=0 returns `next()` before the gate looks at anything,
  // so EVERY /ext/* route on EVERY installed extension becomes anonymous —
  // including the ones whose own handlers assume the gate ran. It exists as an
  // operational safety valve, and a safety valve that can be left open in
  // production is just an open valve.
  if (env.ZVELTIO_EXT_AUTH_GATE === '0') {
    violations.push({
      variable: 'ZVELTIO_EXT_AUTH_GATE',
      message:
        'set to 0, which disables authentication on every /ext/* route of every installed ' +
        'extension. Unset it. If a specific route must be reachable anonymously, declare it ' +
        'public in the extension manifest instead — that is per route and visible in review.',
    });
  }

  return violations;
}

/**
 * Apply the checks, throwing if production is misconfigured.
 *
 * Throwing rather than warning, for the same reason the RLS check throws: a
 * warning does not fail a readiness probe, so a misconfigured replica takes
 * traffic either way.
 */
export function assertProductionConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  const violations = productionGuardViolations(env);
  if (violations.length === 0) return;

  for (const v of violations) {
    console.error(`❌ [startup] ${v.variable} is ${v.message}`);
  }
  throw new Error(
    `Refusing to start in production: ${violations.map((v) => v.variable).join(', ')} ` +
      `${violations.length === 1 ? 'disables a security control' : 'disable security controls'}.`,
  );
}

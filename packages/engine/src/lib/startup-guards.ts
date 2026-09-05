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

import { resolvePoolMax } from '../db/index.js';

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

  // VALKEY_URL absent is not a lighter configuration — it is a set of security
  // controls degrading in silence.
  //
  // Twelve modules call `getCache()` and sixteen have an `if (!cache)` branch.
  //
  // NOT all of those are silent degradation, and the difference matters. The
  // realtime bus has a real second backend — `PgNotifyRealtimeBus` uses
  // LISTEN/NOTIFY through `Bun.SQL.subscribe()`, crosses instances, and applies
  // the same self-echo filter. It is documented, with its limits stated (8 KB
  // payloads, suited to ≤2 replicas). That one is a choice, not a loss.
  //
  // What IS silent: the permission and identity caches. Without Valkey,
  // `isGodUser` and `resolveUserRole` go to the database on every request, and
  // an invalidation — a demoted god, a revoked grant — reaches only the process
  // that performed it. `invalidateUserPermCache` sends its DEL to a cache that
  // is not there, so every other replica keeps serving the old answer until its
  // own in-process entry expires. Nothing reports that.
  //
  // The product already treats Valkey as required, everywhere except here:
  //
  //   docker-compose.yml   depends_on: cache: { condition: service_healthy }
  //   .env.example         VALKEY_PASSWORD=   # REQUIRED
  //   install/install.sh   apt/dnf/yum/pacman, then a prebuilt binary, then a
  //                        build from source — three tiers rather than give up
  //   scripts/install.sh   every mode starts it and waits for `valkey-cli ping`
  //
  // So the fallbacks describe a deployment the product does not ship, and the
  // engine was the only place that accepted it. The two were never put side by
  // side; this is that.
  //
  // Fatal in production only, like the RLS role guard, with the same escape
  // hatch shape: an operator who genuinely runs without it must say so.
  if (!env.VALKEY_URL && env.ZVELTIO_ALLOW_NO_CACHE !== '1') {
    violations.push({
      variable: 'VALKEY_URL',
      message:
        'unset, so the engine runs with no cache. That is not a smaller install: god and ' +
        'role checks hit the database on every request, and a revoked permission reaches ' +
        'only the replica that revoked it — the invalidation is sent to a cache that is ' +
        'not there, and every other replica serves the old answer until its own in-process ' +
        'entry expires. (Realtime is fine either way: it falls back to Postgres ' +
        'LISTEN/NOTIFY, which is a documented backend, not a degradation.) ' +
        'Every shipped install path provisions Valkey — docker-compose depends on it being ' +
        'healthy, and both installers build it from source rather than skip it. ' +
        'Set VALKEY_URL. If this instance genuinely has no cache and you accept the above, ' +
        'set ZVELTIO_ALLOW_NO_CACHE=1 deliberately.',
    });
  }

  // CORS_ORIGINS=* is not a loose setting, it is the absence of one. The
  // WebSocket origin check honours `*` explicitly (lib/security/ws-origin.ts),
  // and Better Auth's trustedOrigins is built from the same list — so a single
  // asterisk turns off both the CSRF origin check on every auth endpoint and
  // the origin check on the realtime socket, for every site on the internet.
  //
  // Unset is deliberately NOT a violation. CORS then denies by default and only
  // trustedOrigins falls back to auto-detected local origins, which is the
  // normal shape of a self-hosted intranet install; auth.ts already warns. `*`
  // is different because there is no configuration under which it is what
  // someone meant.
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.includes('*')) {
    violations.push({
      variable: 'CORS_ORIGINS',
      message:
        'set to `*`, which disables the cross-origin checks on every auth endpoint and on the ' +
        'realtime socket. List the origins that may reach this instance instead.',
    });
  }

  // BETTER_AUTH_URL unset does not fail — it rewrites.
  //
  // `baseURL` falls back to `http://localhost:${PORT}`, and everything downstream
  // is built from it: the passkey relying-party id and origin, the trusted-origin
  // list when CORS_ORIGINS is also unset, and — the one with real consequence —
  // the links Better Auth puts in the mail it sends. A password-reset e-mail then
  // carries `http://localhost:3000/...`, which reaches the person who asked for it
  // and cannot work for them. Nothing errors: the send succeeds, the link is well
  // formed, and the account stays locked out.
  //
  // The other two entries here are settings whose absence is dangerous. This one
  // is a setting whose absence is silent, which is why it belongs beside them
  // rather than in a warning nobody reads at boot.
  if (!env.BETTER_AUTH_URL) {
    violations.push({
      variable: 'BETTER_AUTH_URL',
      message:
        'unset, so the engine builds every absolute URL from `http://localhost:<port>`. ' +
        'That is the address written into password-reset, e-mail-verification and ' +
        'magic-link mail — links that arrive well formed and cannot work — and it is ' +
        'also the passkey relying-party origin and, when CORS_ORIGINS is unset, the ' +
        'trusted-origin list. Set BETTER_AUTH_URL to the URL browsers actually use.',
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
  // Neutral wording, because not every violation is a setting that was TURNED
  // ON: `VALKEY_URL` is fatal when it is ABSENT, and "VALKEY_URL disables a
  // security control" reads as though someone set it to something harmful.
  throw new Error(
    `Refusing to start in production — ${violations.length === 1 ? 'this must' : 'these must'} ` +
      `be resolved first: ${violations.map((v) => v.variable).join(', ')}.`,
  );
}

/**
 * Report the concurrency ceiling this instance is running under.
 *
 * `DB_POOL_MAX` is not a throughput knob — it is a hard ceiling on how many
 * requests can be in flight at once, because the tenant transaction pins one
 * pooled connection for the whole request. Measured on 2026-08-26 with
 * `scripts/bench-concurrency.ts` against `/api/me`: at the default of 10 the
 * curve breaks at about 20 concurrent requests and throughput falls from
 * ~690 req/s to 22 req/s; at 40 it stays flat past 80 with no errors.
 *
 * The default WAS raised to 40, as an owner decision on 2026-08-30 — see the
 * note in `db/index.ts`. It is not free: a default is inherited by every
 * install, including ones running several engines against one Postgres, so the
 * same `max_connections` now carries fewer of them (5 instead of 8, at 200).
 * That trade was made knowingly, against the measurement above.
 *
 * So this prints the arithmetic instead of hiding it: what the ceiling is, what
 * the server allows, and how much room is left. Advisory only — it never
 * refuses to start, because being wrong about the instance count must not take
 * a deployment down.
 */
export async function reportConcurrencyCeiling(db: {
  // biome-ignore lint/suspicious/noExplicitAny: minimal structural shape, avoids importing Kysely here
  executeQuery?: any;
}): Promise<void> {
  const poolMax = resolvePoolMax();
  try {
    const { sql } = await import('kysely');
    const res = await sql<{ max_connections: string }>`SHOW max_connections`.execute(db as never);
    const serverMax = Number(res.rows[0]?.max_connections ?? 0);
    if (!Number.isFinite(serverMax) || serverMax <= 0) return;

    // Postgres reserves superuser slots, and migrations/pg-boss/realtime each
    // want one outside the request pool. Ten is a deliberately rough allowance.
    const usable = Math.max(1, serverMax - 10);
    const instances = Math.floor(usable / poolMax);

    console.log(
      `   Concurrency ceiling: DB_POOL_MAX=${poolMax} in-flight requests per instance ` +
        `(server max_connections=${serverMax}, so ~${instances} instance(s) fit).`,
    );
    if (instances >= 4 && poolMax < 40) {
      console.log(
        `   → Room to raise it: DB_POOL_MAX=${Math.floor(usable / Math.max(1, Math.min(instances, 4)))} ` +
          `would still fit 4 instances. Verify with scripts/bench-concurrency.ts.`,
      );
    }
    if (instances < 2) {
      console.warn(
        `   ⚠ DB_POOL_MAX=${poolMax} leaves room for fewer than 2 engine instances ` +
          `against max_connections=${serverMax}. A second instance will fail with ` +
          `"sorry, too many clients already".`,
      );
    }
  } catch {
    // Diagnostics must never be the reason a boot fails.
  }
}

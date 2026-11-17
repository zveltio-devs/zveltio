/**
 * The operational-mode register (ADR 0058 decision 4): every setting that turns
 * a guarantee of the engine off, what it weakens, its class and when it goes.
 *
 * Three rules hang on it:
 *  - this module is the only reader of these variables — everything else asks
 *    `modeValue`, so a new hatch cannot exist without an entry here;
 *  - the boot warns for every mode that is on (`warnOperationalModes`);
 *  - the "Escape hatches" table in docs/platform/configuration.md is generated
 *    from `MODES` (`bun run scripts/gen-operational-modes.ts`).
 * `scripts/gen-operational-modes.ts --check` enforces the first and the last.
 *
 * No imports, on purpose: the extension runner loads subprocess-runner.ts, and
 * through it this file, from source on a read-only root with no node_modules.
 */

type Env = Record<string, string | undefined>;

export type ModeClass =
  /** Gone: nothing reads it. Set, it only earns a boot warning. */
  | 'removed'
  /** Kept until `removal`. */
  | 'dated'
  /** Kept. */
  | 'permanent'
  /** Not a variable: an exemption an authorized admin delegates, row by row. */
  | 'delegated'
  /** A Console setting that weakens; becomes an environment hatch with a date (DR-10 slice B). */
  | 'pending'
  /** The platform's variable; its readers are not routed here (see the entry). */
  | 'platform';

export interface Mode {
  class: ModeClass;
  /** What it turns off. */
  weakens: string;
  /** When it is defensible. */
  when: string;
  /** The version it goes in, or `permanent`. */
  removal: string;
  /** True when the value turns the mode on. Absent for what is not a variable. */
  on?: (v: string | undefined) => boolean;
}

const is =
  (...values: string[]) =>
  (v: string | undefined) =>
    v !== undefined && values.includes(v.trim());
const nonEmpty = (v: string | undefined) => Boolean(v?.trim());

export const MODES = {
  ZVELTIO_COLLECTION_RLS_EXEMPT: {
    class: 'removed',
    weakens:
      'Was: the listed extensions ran without collection permissions in the database. ' +
      'Removed — no extension is exempt, and a membership of `zveltio_coll_exempt` granted ' +
      'before the upgrade admits nothing (migration 125).',
    when: 'Never. Adapt the extension (`ctx.internals.asSystem`).',
    removal: 'removed (ADR 0058)',
    on: nonEmpty,
  },
  ZVELTIO_ALLOW_UNENFORCED_RLS: {
    class: 'removed',
    weakens:
      'Was: starting in production when the engine role bypasses RLS and `zveltio_rls` is ' +
      'unavailable. Removed — that boot is refused.',
    when: 'Never. Run the engine as a plain role, or let migration 030 create `zveltio_rls`.',
    removal: 'removed (ADR 0058)',
    on: is('1'),
  },
  DEMO_MODE_ALLOW_IN_PROD: {
    class: 'removed',
    weakens:
      'Was: the demo account credentials on `/api/health` in production. Removed — production ' +
      'never publishes them.',
    when: 'Never.',
    removal: 'removed (ADR 0058)',
    on: is('true'),
  },
  ALLOW_INSECURE_LDAP: {
    class: 'dated',
    weakens:
      'Refusing plaintext LDAP binds (auth/ldap): with `true` or `1`, passwords cross the network in the clear.',
    when: 'A directory on a private network that cannot do LDAPS or StartTLS yet.',
    removal: '3.1.0',
    on: is('1', 'true'),
  },
  ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS: {
    class: 'dated',
    weakens:
      'Refusing to write a field marked `encrypted: true` when `FIELD_ENCRYPTION_KEY` is unset. ' +
      'With `=1` the value is stored in the clear.',
    when: 'Never on an install holding PII. A development database, or a deliberate migration off encryption.',
    removal: '3.1.0',
    on: is('1'),
  },
  ZVELTIO_FAIL_CLOSED_TENANT: {
    class: 'dated',
    weakens:
      "The closed tenant fallback: with `=0` a query with no tenant context reads and writes the default tenant's rows instead of none.",
    when: "A single-tenant install whose own code (an extension's background work, a script on the engine's role) reads tenant tables without a tenant, until that code sets one.",
    removal: '3.1.0',
    on: is('0'),
  },
  ZVELTIO_SINGLE_INSTANCE: {
    class: 'permanent',
    weakens:
      'The production refusal to run without `VALKEY_URL`: with `=1` one instance runs without a ' +
      'cache, instances heartbeat in `zv_instances` and only the newest serves.',
    when: 'Exactly one engine process.',
    removal: 'permanent',
    on: is('1'),
  },
  REQUIRE_EXTENSION_SIGNATURES: {
    class: 'permanent',
    weakens:
      'Refusing an extension archive without a registry signature. With `=false` a missing ' +
      'signature is a warning; until the registry-signed tier lands an unsigned directory named ' +
      'like a first-party extension also loads inline (U3).',
    when: 'A private mirror that does not sign yet.',
    removal: 'permanent, once the registry-signed tier lands (U3)',
    on: is('false'),
  },
  ZVELTIO_EXT_TRANSPORT: {
    class: 'permanent',
    weakens:
      'With `=process`, a worker-isolated extension runs as a child of the engine, under its uid. ' +
      'Refused in production (any `NODE_ENV` but `development` or `test`, unset included), where it runs on the extension runner.',
    when: 'Development without a runner.',
    removal: 'permanent',
    on: is('process'),
  },
  ZVELTIO_EDGE_TRANSPORT: {
    class: 'permanent',
    weakens:
      'Where edge function invocations and flow `run_script` steps run in **development** ' +
      '(`NODE_ENV=development` or `test`): unset or `process`, a child of the engine, under the ' +
      "engine's user — the named development placement, logged once, no boundary; `=runner`, the " +
      'extension runner. In production — every other `NODE_ENV`, unset included — every ' +
      'invocation runs on the extension runner ([RFC](../engine/rfc-extension-runner.md), steps 5 ' +
      'and 10; ADR 0058) whatever its egress, and `=process` stops the engine at boot: the ' +
      '`zveltio-ext-runner@edge` instance on bare metal, the runner container ' +
      '(`ZVELTIO_EXT_RUNNER_SOCKET`) in compose and Helm, under a uid that cannot read the ' +
      "engine's files, environment or processes, with no network. On the runner a function's " +
      '`fetch` crosses to the engine, which performs it with the SSRF guard and only to the hosts ' +
      "in its `egress` (a column of the function, set in Studio; exact `host` on the scheme's " +
      'default port, or `host:port`; every redirect hop checked again; 1 MiB request and 5 MiB ' +
      'response bodies, 50 requests and 6 in flight per invocation); a function that declares no ' +
      'egress is refused until it lists its hosts. Same ceilings (`EDGE_MEMORY_LIMIT_MB`, ' +
      '`EDGE_CPU_LIMIT_S`, below 1024 MiB floored: the runner has no per-invocation cgroup), same ' +
      'results; no pre-spawned pool.',
    when: '`=runner` on a development machine that has a runner. Never in production, where it changes nothing and `=process` is refused.',
    removal: 'permanent',
    on: is('process'),
  },
  ZVELTIO_ALLOW_MIGRATION_DIVERGENCE: {
    class: 'permanent',
    weakens: 'Refusing to start against a schema newer than the binary.',
    when: 'A rollback window you are actively supervising.',
    removal: 'permanent',
    on: is('1'),
  },
  ZVELTIO_ALLOW_MISSING_DB: {
    class: 'permanent',
    weakens:
      'Gates and the harness lane refusing to run without a database, rather than passing having checked nothing. Never read by a running engine.',
    when: 'A lint-only CI job that genuinely has no Postgres.',
    removal: 'permanent',
    on: is('1'),
  },
  METRICS_ALLOW_UNAUTHENTICATED: {
    class: 'permanent',
    weakens: '`/metrics` refusing anonymous callers when no `METRICS_TOKEN` is set.',
    when: 'A Prometheus scraper on a private network.',
    removal: 'permanent',
    on: is('1'),
  },
  RATE_LIMIT_ALLOWLIST: {
    class: 'permanent',
    weakens: 'Rate limiting, for the listed CIDRs.',
    when: 'An internal load generator, or a known reverse proxy.',
    removal: 'permanent',
    on: nonEmpty,
  },
  ZVELTIO_REGISTRATION_ENABLED: {
    class: 'permanent',
    weakens:
      'The refusal to self-register (`registration_disabled`). `1` or `true` opens ' +
      '`POST /api/auth/sign-up/email` to anyone; any other non-empty value closes it, whatever ' +
      'the Console says.',
    when: 'An instance that is genuinely meant to accept public sign-ups.',
    removal: 'permanent',
    on: is('1', 'true'),
  },
  NODE_ENV: {
    class: 'platform',
    weakens:
      '`development` or `test` turns off the production refusals: `productionGuardViolations` ' +
      '(no cache, `CORS_ORIGINS=*`, …), the RLS-unenforceable refusal, the extension-runner ' +
      'requirement and edge placement, Secure session cookies, the admin gate on ' +
      '`/api/openapi.json`, the demo credentials kept off `/api/health`, and mounts the ' +
      'unauthenticated `POST /__zveltio_dev_reload`. Every other value — unset included — is ' +
      'production (ADR 0058, owner 2026-11-17): a hand-started engine without it boots as ' +
      'production. Every guard asks `isProduction()`; `check:modes` refuses a direct comparison ' +
      "with `'production'`.",
    when: 'Set `NODE_ENV=development` (or `test`) explicitly on a machine that serves nobody.',
    removal: 'permanent',
    on: (v) => v === 'development' || v === 'test',
  },
  'zv_api_keys.rls_bypass': {
    class: 'delegated',
    weakens:
      "An API key that reads past row rules, within its issuer's own `data:view_all` (ADR 0028, 0037). Set per key by an admin who holds it; never by a variable.",
    when: 'A service key that must read whole collections, such as an export.',
    removal: 'permanent',
  },
  'auth/ldap tlsVerify=false': {
    class: 'pending',
    weakens: 'LDAPS certificate verification (auth/ldap), set from the Console.',
    when: 'A directory with a self-signed certificate. Leaves the Console for an environment variable with a date (DR-10 slice B).',
    removal: 'moves to the environment (DR-10 slice B)',
  },
  'auth/saml audience=false': {
    class: 'pending',
    weakens: 'The SAML assertion audience check (auth/saml), set from the Console.',
    when: 'An identity provider that sends a wrong audience. Leaves the Console for an environment variable with a date (DR-10 slice B).',
    removal: 'moves to the environment (DR-10 slice B)',
  },
} as const satisfies Record<string, Mode>;

type Modes = typeof MODES;

/** The variables something may still read: every entry with a value, but the removed. */
export type ModeVariable = {
  [K in keyof Modes]: Modes[K] extends { on: unknown; class: infer C }
    ? C extends 'removed' | 'platform'
      ? never
      : K
    : never;
}[keyof Modes];

/**
 * Whether this engine runs as production (ADR 0058 d4, owner 2026-11-17): every
 * `NODE_ENV` but `development` and `test`, unset included — a hand-started
 * engine has none. The one answer for every guard. `env` is read as an object,
 * never as the literal `process.env.NODE_ENV`, which `bun build` inlines.
 */
export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
}

/**
 * The raw `NODE_ENV`, for what is not a guard (test-only shortcuts, logs, a
 * child's environment). Read as an object property so `bun build` cannot inline
 * it; `check:modes` refuses a literal `process.env.NODE_ENV` read elsewhere.
 */
export function nodeEnv(env: Env = process.env): string | undefined {
  return env.NODE_ENV;
}

/** The one read of a registered variable. */
export function modeValue(name: ModeVariable, env: Env = process.env): string | undefined {
  return env[name];
}

/** One line per mode that is on, and per removed variable still set. */
export function operationalModeWarnings(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const [name, mode] of Object.entries(MODES) as [string, Mode][]) {
    if (!mode.on?.(env[name])) continue;
    out.push(
      mode.class === 'removed'
        ? `[modes] ${name} is set, but it was removed (ADR 0058) and has no effect: unset it.`
        : `[modes] ${name}=${env[name] ?? '(unset)'} — ${mode.class}, ${mode.removal}: ${mode.weakens}`,
    );
  }
  return out;
}

/** At every boot. */
export function warnOperationalModes(env: Env = process.env): void {
  for (const line of operationalModeWarnings(env)) console.warn(`⚠️  ${line}`);
}

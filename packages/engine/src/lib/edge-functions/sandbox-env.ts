/**
 * The environment handed to an edge-function sandbox.
 *
 * A Bun Worker inherits the parent's environment unless it is given its own, and
 * the sandbox's `process` stub lives on `globalThis` — which
 * `await import('node:process')` walks straight around, because the module
 * loader is not reachable through globals. So the lockdown never kept
 * DATABASE_URL, BETTER_AUTH_SECRET or FIELD_ENCRYPTION_KEY away from
 * edge-function code; only this does.
 *
 * Deliberately an allowlist rather than a denylist of secret-looking names: a
 * denylist has to be updated every time a new secret is introduced, and the one
 * that gets forgotten is the one that leaks.
 */
export function sandboxWorkerEnv(): Record<string, string> {
  return { NODE_ENV: process.env.NODE_ENV ?? 'production' };
}

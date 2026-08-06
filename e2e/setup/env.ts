/**
 * Values shared by the boot script and the specs.
 *
 * Deliberately free of Bun-specific APIs. `boot.ts` runs under Bun and uses
 * `import.meta.dir`, `Bun.spawn` and friends; the specs run under Playwright's
 * own loader, which cannot parse those. Importing the boot script from a spec
 * failed with "Cannot use 'import.meta' outside a module" and reported it as
 * "No tests found", which is a confusing way to learn about a module boundary.
 */

const PORT = process.env.E2E_PORT ?? '3399';
const DB_NAME = process.env.E2E_DB ?? 'zveltio_e2e';
const PG_ADMIN = process.env.E2E_PG_ADMIN ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export const E2E = {
  port: PORT,
  baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`,
  dbName: DB_NAME,
  pgAdminUrl: PG_ADMIN,
  dbUrl: PG_ADMIN.replace(/\/[^/]*$/, `/${DB_NAME}`),
  /**
   * The account `boot.ts` creates with `create-god`. Every journey that needs
   * an authenticated administrator signs in as this one; nothing seeds users
   * through SQL, so what the suite exercises is the same path an operator uses.
   */
  admin: { email: 'e2e-admin@test.invalid', password: 'E2ePassw0rd!' },
} as const;

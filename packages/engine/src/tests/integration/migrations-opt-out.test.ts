/**
 * `MIGRATIONS_AUTO=false` does not apply migrations, and the advisory lock
 * covers the pass that does the work.
 *
 * `initDatabase()` used to call the migration runner itself, and `autoMigrate`
 * -- the one holding the pg advisory lock, the one `MIGRATIONS_AUTO` gates, and
 * the one calling `assertChainCompatible` -- is reached AFTER it on the boot
 * path. So three things were untrue at once: the opt-out did not opt out, the
 * lock protected a second pass that had nothing left to do, and the guard
 * against an incompatible chain ran after that chain had been applied.
 *
 * Measured before the change on a virgin database with the flag set: 72 tables.
 *
 * This test needs to create a database, so it asks the server for one from the
 * same cluster as TEST_DATABASE_URL and skips when it cannot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const d = TEST_DB_URL ? describe : describe.skip;
const SCRATCH = `zv_migopt_${Date.now()}`;

d('MIGRATIONS_AUTO=false leaves the schema alone', () => {
  let admin: SQL | null = null;
  let usable = false;

  beforeAll(async () => {
    try {
      admin = new SQL({ url: withDatabase(TEST_DB_URL!, 'postgres'), max: 1 });
      await admin.unsafe(`CREATE DATABASE "${SCRATCH}"`);
      usable = true;
    } catch {
      usable = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (admin && usable) await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  it('creates the tracking table and nothing else', async () => {
    if (!usable) return; // no permission to create a database here
    const url = withDatabase(TEST_DB_URL!, SCRATCH);

    // A separate process, because initDatabase caches a module-level handle and
    // this suite's other files have already built one against another database.
    const script = `
      process.env.DATABASE_URL = ${JSON.stringify(url)};
      process.env.MIGRATIONS_AUTO = 'false';
      process.env.DB_POOL_AUTOSIZE = '0';
      const { initDatabase } = await import(${JSON.stringify(
        new URL('../../db/index.ts', import.meta.url).pathname,
      )});
      const { sql } = await import('kysely');
      const db = await initDatabase();
      const r = await sql\`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'\`.execute(db);
      console.log('TABLES=' + r.rows[0].n);
      process.exit(0);
    `;
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const seen = /TABLES=(\d+)/.exec(out);
    expect(seen).not.toBeNull();
    // zv_migrations only. The runner needs it to exist; it applies nothing.
    expect(Number(seen![1])).toBe(1);
  }, 180_000);
});

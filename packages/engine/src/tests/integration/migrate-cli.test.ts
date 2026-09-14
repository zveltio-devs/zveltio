/**
 * `zveltio migrate` applies the migrations. It is the command an operator types
 * and the one both installers run.
 *
 * It stopped doing that in 93b96c14, which moved the runner off the connect
 * path so `MIGRATIONS_AUTO=false` could genuinely opt out and the advisory lock
 * could protect the pass that does the work — both correct. The CLI branch was
 * left calling only `initDatabase()`, which now creates the tracking table and
 * nothing else, then printed `✅ Migrations complete`.
 *
 * Measured on a virgin database before the repair: 1 table. A migrated one has
 * 73. Nothing failed, nothing warned — `install.sh`, `update.sh` and the Helm
 * migration job all ran it and were told it had worked. CHANGELOG records the
 * same symptom once before, at 3.0.0-beta.63, from a different cause.
 *
 * The engine's own boot still migrates, so an install that starts the server
 * normally recovers on the next start. The combination this breaks is the one
 * the command exists for: migrate first, with the boot-time migration off.
 *
 * Creates a database, so it asks the server for one from the same cluster as
 * TEST_DATABASE_URL and skips when it cannot.
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
const SCRATCH = `zv_migcli_${Date.now()}`;

d('the migrate CLI applies migrations', () => {
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

  it('lands the whole schema, not just the tracking table', async () => {
    if (!usable) return; // no permission to create a database here
    const url = withDatabase(TEST_DB_URL!, SCRATCH);
    const entry = new URL('../../index.ts', import.meta.url).pathname;

    // A separate process: this is the real command, argv and all, and
    // `initDatabase` caches a module-level handle other suites already built.
    const proc = Bun.spawn(['bun', entry, 'migrate'], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        DB_POOL_AUTOSIZE: '0',
        // The operator's case: boot-time migration off, migrate explicitly.
        // The command must not inherit the opt-out meant for startup.
        MIGRATIONS_AUTO: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    expect(code).toBe(0);
    expect(out).toContain('Migrations complete');

    const probe = new SQL({ url, max: 1 });
    try {
      const rows = await probe.unsafe(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`,
      );
      // The exact count moves with the chain; "more than the tracking table"
      // is the property, and 1 is precisely what the defect produced.
      expect(rows[0].n).toBeGreaterThan(10);
      const named = await probe.unsafe(`SELECT to_regclass('public.zv_api_keys') AS t`);
      expect(named[0].t).not.toBeNull();
    } finally {
      await probe.end().catch(() => {});
    }
  }, 180_000);
});

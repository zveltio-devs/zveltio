/**
 * Zveltio supports PostgreSQL 18 only, and refuses an older server before any
 * migration runs (db/postgres-version.ts).
 *
 * An older server is simulated on a scratch database: a `current_setting`
 * shadowing pg_catalog's (search_path puts its schema ahead) reports
 * server_version_num 170006 and passes every other setting through. So the
 * real gate query, the real runner and the real engine process all see "17.6".
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { rollbackMigration, runMigrations } from '../../db/migrations/index.js';
import { assertSupportedPostgres, postgresVersionRefusal } from '../../db/postgres-version.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const ENGINE = join(import.meta.dir, '../../..');
const REFUSED =
  /PostgreSQL 17\.6 found \(server_version_num 170006\); Zveltio requires PostgreSQL 18/;

describe('postgresVersionRefusal', () => {
  it('refuses below 18 and names the version found', () => {
    expect(postgresVersionRefusal(170000)).toContain('PostgreSQL 17.0 found');
    expect(postgresVersionRefusal(179999)).toContain('requires PostgreSQL 18 (with pgvector)');
    expect(postgresVersionRefusal(160004)).toContain('PostgreSQL 16.4 found');
  });
  it('accepts 18', () => {
    expect(postgresVersionRefusal(180000)).toBeNull();
    expect(postgresVersionRefusal(180004)).toBeNull();
  });
});

const d = harnessAvailable() ? describe : describe.skip;

d('PostgreSQL version gate: an older server is refused before any migration', () => {
  const superUrl = new URL(String(process.env.TEST_DATABASE_URL));
  const key = createHash('sha256').update(superUrl.pathname).digest('hex').slice(0, 8);
  const DB = `zz_pgver_${key}`;
  const fakeUrl = (() => {
    const u = new URL(superUrl);
    u.pathname = `/${DB}`;
    return u.toString();
  })();
  let sup: Database;
  let fake: Database;

  /** Whether any table the runner or `initDatabase` creates first exists. */
  const migrated = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_class
         WHERE relname IN ('zv_migrations', 'zv_schema_versions')`.execute(fake)
    ).rows[0]!.n;

  beforeAll(async () => {
    sup = createDb(superUrl.toString());
    await sql.raw(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).execute(sup);
    await sql.raw(`CREATE DATABASE ${DB}`).execute(sup);
    const setup = createDb(fakeUrl);
    await sql`CREATE SCHEMA zv_fake`.execute(setup);
    await sql`
      CREATE FUNCTION zv_fake.current_setting(name text) RETURNS text LANGUAGE sql AS $$
        SELECT CASE WHEN name = 'server_version_num' THEN '170006'
                    ELSE pg_catalog.current_setting(name) END $$`.execute(setup);
    await sql
      .raw(`ALTER DATABASE ${DB} SET search_path = public, zv_fake, pg_catalog`)
      .execute(setup);
    await setup.destroy();
    fake = createDb(fakeUrl); // new connections pick up the database's search_path
  }, 30_000);

  afterAll(async () => {
    await fake?.destroy().catch(() => {});
    await sql.raw(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).execute(sup);
    await sup.destroy().catch(() => {});
  }, 30_000);

  it('the scratch database really reports 17.6 to the gate', async () => {
    await expect(assertSupportedPostgres(fake)).rejects.toThrow(REFUSED);
  });

  it('this cluster (18) passes', async () => {
    await expect(assertSupportedPostgres(sup)).resolves.toBeUndefined();
  });

  it('every runner under the migration lock refuses — the createDb path of db/migrate.ts', async () => {
    await expect(runMigrations(fake)).rejects.toThrow(REFUSED);
    const rb = await rollbackMigration(fake, 0);
    expect(rb.success).toBe(false);
    expect(rb.error ?? '').toMatch(REFUSED);
    expect(await migrated()).toBe(0);
  });

  it('initDatabase refuses: `bun src/index.ts migrate` exits non-zero and writes nothing', async () => {
    const p = Bun.spawn(['bun', 'src/index.ts', 'migrate'], {
      cwd: ENGINE,
      env: {
        ...process.env,
        DATABASE_URL: fakeUrl,
        NATIVE_DATABASE_URL: '',
        PORT: '0',
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET || 'pgver-test-secret-0123456789abcdef0123',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => p.kill(), 90_000);
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    const all = `${out}\n${err}`;
    expect(p.exitCode, all.slice(-2000)).not.toBe(0);
    expect(all).toMatch(REFUSED);
    expect(await migrated()).toBe(0);
  }, 120_000);
});

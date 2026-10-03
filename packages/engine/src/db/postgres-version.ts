/**
 * Zveltio supports exactly one PostgreSQL major: 18, with pgvector (CI and
 * docker-compose.yml pin `pgvector/pgvector:pg18`). Nothing checked it, so an
 * older server got as far as some migration or role grant that used newer
 * syntax and failed there, mid-chain, with a Postgres error that named neither
 * the version nor the requirement.
 *
 * Two callers, one gate: `initDatabase` (boot, `zveltio migrate` through the
 * engine binary, the CLI's direct path, the test harness) and
 * `withMigrationLock` (every runner that changes the schema, on whatever handle
 * — `db/migrate.ts` connects with `createDb`, never through `initDatabase`).
 * Both run it before anything is written.
 *
 * `current_setting`, not `SHOW`: one is an ordinary function call, which a test
 * can stand in for on a scratch database (search_path ahead of pg_catalog).
 */
import { sql } from 'kysely';
import type { Database } from './index.js';

export const MIN_SERVER_VERSION_NUM = 180000;

/** The refusal for `num`, or null when the server is supported. */
export function postgresVersionRefusal(num: number): string | null {
  if (num >= MIN_SERVER_VERSION_NUM) return null;
  const found = `${Math.floor(num / 10000)}.${num % 10000}`;
  return (
    `PostgreSQL ${found} found (server_version_num ${num}); Zveltio requires ` +
    'PostgreSQL 18 (with pgvector). Upgrade the server, then start again — no migration was run.'
  );
}

export async function assertSupportedPostgres(db: Database): Promise<void> {
  const { rows } = await sql<{ v: string }>`
    SELECT current_setting('server_version_num') AS v`.execute(db);
  const refusal = postgresVersionRefusal(Number(rows[0]?.v));
  if (refusal) throw new Error(refusal);
}

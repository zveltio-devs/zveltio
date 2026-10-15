/**
 * Run a migration file's UP on the shared harness database.
 *
 * A test that re-runs an old migration redefines its functions as that file
 * wrote them, and every later file in the run then sees the old definition.
 * Re-run the later migrations that changed them too (`080` and `082` after
 * 017/034/059; a DOWN that drops a function also drops 082's REVOKE).
 */
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';

export async function rerunMigration(db: Database, file: string): Promise<void> {
  const text = await Bun.file(new URL(`../../db/migrations/sql/${file}`, import.meta.url)).text();
  await sql.raw(parseMigrationFile(text).up).execute(db);
}

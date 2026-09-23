import './setup';
import { describe, it, expect } from 'bun:test';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Driver,
} from 'kysely';
import { applyMigrationStrings } from '../testing/with-test-db.js';

/**
 * The harness other suites trust.
 *
 * A Zveltio migration keeps its rollback in the same file behind a `-- DOWN`
 * marker, and the documented way to use this helper is to glob
 * `engine/migrations/*.sql` and hand every file to it. Running the whole file
 * creates the schema and then drops it again inside the same call.
 */
function recordingDb(sink: string[]) {
  const connection = {
    async executeQuery(compiled: { sql: string }) {
      sink.push(compiled.sql);
      return { rows: [] };
    },
    async *streamQuery() {},
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection as never;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  return new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe('applyMigrationStrings', () => {
  it('does not run the DOWN half of a migration', async () => {
    const executed: string[] = [];
    const db = recordingDb(executed);
    await applyMigrationStrings(db, ['CREATE TABLE zvd_t (id TEXT);\n-- DOWN\nDROP TABLE zvd_t;']);
    expect(executed.join('\n')).toContain('CREATE TABLE');
    expect(
      executed.join('\n'),
      'the rollback ran against the schema it had just created',
    ).not.toContain('DROP TABLE');
    await db.destroy();
  });

  it('still runs every statement of a file with no DOWN section', async () => {
    const executed: string[] = [];
    const db = recordingDb(executed);
    await applyMigrationStrings(db, ['CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);']);
    expect(executed).toHaveLength(2);
    await db.destroy();
  });
});

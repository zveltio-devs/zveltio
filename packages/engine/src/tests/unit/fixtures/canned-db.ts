/**
 * CannedDb — a REAL Kysely instance backed by a fake driver that answers
 * queries from registered handlers instead of Postgres.
 *
 * Purpose: unit-test DB-bound lib/ modules (the ones whose logic is "given
 * these rows, do/produce that") without a live database. Unlike the ad-hoc
 * fake query-builder pattern (see validation-engine.test.ts), this goes
 * through Kysely's actual compiler, so `sql` template tags, the query
 * builder, AND `db.transaction().execute(...)` all work unmodified.
 *
 * Usage:
 *   const db = new CannedDb();
 *   db.when(/insert into "zv_quality_scans"/, [{ id: 'scan-1' }]);
 *   db.fail(/set_config/, new Error('boom'));
 *   await runQualityScan(db.kysely as unknown as Database, ...);
 *   const inserts = db.executed(/insert into "zv_quality_issues"/);
 *
 * Handlers are matched against the compiled SQL, LAST registered wins (so a
 * test can override a fixture default). Unmatched queries return zero rows.
 * Every executed query is recorded in `log` for assertions; `waitFor` polls
 * the log so fire-and-forget async paths can be awaited deterministically.
 */

import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { CompiledQuery, DatabaseConnection, Dialect, Driver, QueryResult } from 'kysely';

export interface ExecutedQuery {
  sql: string;
  parameters: readonly unknown[];
}

type RowsProvider = unknown[] | ((q: ExecutedQuery) => unknown[]);

interface CannedHandler {
  match: RegExp;
  rows?: RowsProvider;
  error?: Error;
}

export class CannedDb {
  readonly log: ExecutedQuery[] = [];
  // Untyped on purpose: modules under test query dynamic zvd_* tables.
  readonly kysely: Kysely<any>;
  private handlers: CannedHandler[] = [];

  constructor() {
    const self = this;

    const connection: DatabaseConnection = {
      async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const q: ExecutedQuery = { sql: compiled.sql, parameters: compiled.parameters };
        self.log.push(q);
        for (let i = self.handlers.length - 1; i >= 0; i--) {
          const h = self.handlers[i]!;
          if (h.match.test(q.sql)) {
            if (h.error) throw h.error;
            const rows = typeof h.rows === 'function' ? h.rows(q) : (h.rows ?? []);
            return { rows: rows as R[], numAffectedRows: BigInt(rows.length) };
          }
        }
        return { rows: [], numAffectedRows: 0n };
      },
      async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
        throw new Error('CannedDb does not support streaming');
      },
    };

    const driver: Driver = {
      async init() {},
      async acquireConnection() {
        return connection;
      },
      async beginTransaction() {},
      async commitTransaction() {},
      async rollbackTransaction() {},
      async releaseConnection() {},
      async destroy() {},
    };

    const dialect: Dialect = {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    };

    this.kysely = new Kysely({ dialect });
  }

  /** Register canned rows for queries whose compiled SQL matches. Returns `this` for chaining. */
  when(match: RegExp, rows: RowsProvider): this {
    this.handlers.push({ match, rows });
    return this;
  }

  /** Make matching queries reject. Returns `this` for chaining. */
  fail(match: RegExp, error: Error = new Error('canned failure')): this {
    this.handlers.push({ match, error });
    return this;
  }

  /** All executed queries whose SQL matches. */
  executed(match: RegExp): ExecutedQuery[] {
    return this.log.filter((q) => match.test(q.sql));
  }

  /**
   * Poll until a matching query has executed (for fire-and-forget async paths).
   * Throws with the observed log on timeout so failures are diagnosable.
   */
  async waitFor(match: RegExp, timeoutMs = 2000): Promise<ExecutedQuery> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.log.find((q) => match.test(q.sql));
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `waitFor(${match}) timed out after ${timeoutMs}ms. Executed:\n` +
            this.log.map((q) => `  ${q.sql}`).join('\n'),
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

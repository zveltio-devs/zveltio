/**
 * The read gate: what one caller may read from one collection.
 *
 * Four mechanisms decide it — row policies (`getRlsFilters`), extension query
 * alters (`queryAlterRegistry`), extension entity-access checks
 * (`entityAccessRegistry`, op `view`) and column permissions
 * (`getColumnAccess`). Every read path used to call them one by one, and each
 * new path forgot one: `?as_of=` skipped entity access (#723) and alters
 * (#724); sync pull, `?expand=` and the realtime doors skipped alters and
 * entity access. A read path now asks for a `ReadScope` and uses it; the
 * mechanisms are resolved in one place, so a path cannot pick a subset.
 *
 * Writes are out of scope: they check `update`/`delete` and writable columns,
 * which is a different question.
 */

import type { Database } from '../../db/index.js';
import { DDLManager } from './ddl-manager.js';
import { queryAlterRegistry } from './query-alter.js';
import { dynamicDb } from './write-pipeline.js';
import {
  applyColumnAccess,
  applyRlsFilters,
  entityAccessRegistry,
  getColumnAccess,
  getRlsFilters,
  matchesRlsFilters,
  resolveUserRole,
  type ColumnAccess,
} from '../tenancy/index.js';

export type RlsFilter = Awaited<ReturnType<typeof getRlsFilters>>[number];
type ReadUser = Parameters<typeof getRlsFilters>[1];

export interface ReadScope {
  /** The physical table the alters and entity checks are registered against. */
  table: string;
  /** Row policies, for readers that render them themselves (`?as_of=` in SQL). */
  rls: RlsFilter[];
  columns: ColumnAccess;
  /**
   * An extension alter changes what this caller reads. A reader that has rows
   * but no query (a `?as_of=` snapshot, a realtime event) cannot run an alter,
   * so it must refuse — `admits` does.
   */
  altersRestrict: boolean;
  /** Alters + row policies onto a SELECT builder. */
  query<Q>(qb: Q): Q;
  /** The fetched rows entity access lets the caller `view`. */
  keep<R>(rows: R[]): Promise<R[]>;
  /** One row that did not come through `query`: all three row gates in memory. */
  admits(row: Record<string, unknown>): Promise<boolean>;
  /** Column permissions onto one row: the same row, minus the hidden columns. */
  shape<R extends Record<string, unknown>>(row: R): R;
}

/**
 * Resolve the gate. Nothing is caught: a failed policy, role or column lookup
 * read as "nothing to filter" is how rows leaked before, so it refuses instead.
 *
 * `user` goes to the row policies and the extensions as given — the realtime
 * doors pass it with the resolved role, REST without — and the role for the
 * column permissions is resolved from it.
 */
export async function readScope(
  db: Database,
  collection: string,
  user: ReadUser,
  authType: 'session' | 'api_key',
): Promise<ReadScope> {
  const table = DDLManager.getTableName(collection);
  const rls = await getRlsFilters(collection, user, authType);
  const columns = await getColumnAccess(db, collection, await resolveUserRole(user), user.id);
  // Lazy: the probe runs every alter once more, which only a reader without a
  // query needs. Eager, every live read called each extension alter twice.
  let restricts: boolean | undefined;
  const altersRestrict = () =>
    (restricts ??= queryAlterRegistry.restricts(dynamicDb(db), table, user));
  const viewable = (row: unknown) => entityAccessRegistry.isAllowed(table, row, user, 'view');

  return {
    table,
    rls,
    columns,
    get altersRestrict() {
      return altersRestrict();
    },
    query: (qb) => applyRlsFilters(queryAlterRegistry.applyAll(qb, table, user), rls),
    keep: async (rows) => {
      if (!entityAccessRegistry.hasChecksFor(table)) return rows;
      const decisions = await Promise.all(rows.map(viewable));
      return rows.filter((_, i) => decisions[i] === true);
    },
    admits: async (row) => {
      if (altersRestrict()) return false;
      if (rls.length > 0 && !matchesRlsFilters(row, rls)) return false;
      return viewable(row);
    },
    shape: (row) => applyColumnAccess(row, columns) as typeof row,
  };
}

/**
 * Which revisions one caller may read, and what of them.
 *
 * A revision is a copy of a record, so it answers to the record's read gate —
 * the same rule as the record's comments, with no tenant-admin exception:
 * collection `read`, the row through `readScope` (row rules, extension alters,
 * entity access), and the copy shaped by the caller's column permissions.
 *
 * The rule, per collection:
 *   - nothing narrows what the caller reads (no row rule applies to them, no
 *     alter restricts them): every revision of the collection, the history of
 *     deleted records included — there is no row they could not have read;
 *   - otherwise: only revisions of a record they can read NOW. A delete
 *     revision, or any revision of a record since deleted, has no live row to
 *     judge, so it is not theirs.
 *
 * Both `/api/revisions` and `/api/admin/revisions` read through here. The list
 * used to show `r.*` for every row of a readable collection (`?record_id=` of a
 * hidden row gave its data back), judged a delete by the collection alone,
 * never applied column permissions, and found collections by `SELECT DISTINCT`
 * over the whole table — which also surfaced dropped collections through an
 * orphan grant. Collections now come from the registry.
 *
 * Session callers only: both routes refuse API keys.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { checkPermission, entityAccessRegistry } from '../tenancy/index.js';
import { DDLManager, SYSTEM_COLUMNS } from './ddl-manager.js';
import { readScope, type ReadScope } from './read-scope.js';
import { dynamicDb, isUuid } from './write-pipeline.js';
import { serializeRecord } from './shape.js';

export interface RevisionQuery {
  id?: string;
  collection?: string;
  record_id?: string;
  user_id?: string;
  action?: string;
  limit: number;
  offset: number;
  /** Also count every visible revision matching the filter. */
  total?: boolean;
}

export interface RevisionRow {
  id: string;
  collection: string;
  record_id: string;
  action: string;
  data: Record<string, unknown>;
  delta: Record<string, unknown> | null;
  [column: string]: unknown;
}

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

function asObject(v: unknown): Record<string, unknown> {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * A stored copy as this caller reads the record: serialized as `GET
 * /api/data/:collection/:id` serializes the live row — their column
 * permissions, a `password` field left out, an encrypted one decrypted, the
 * FTS columns stripped. Shaped by column permissions alone, the list served the
 * argon2 hash and the `enc:v1:` ciphertext; decrypted, a revert restores the
 * encrypted value (the PATCH re-encrypts it).
 */
export async function shapeRevisionData(
  db: Database,
  scope: ReadScope,
  collection: string,
  v: unknown,
): Promise<Record<string, unknown>> {
  return serializeRecord(
    asObject(v),
    await DDLManager.getCollection(db, collection),
    scope.columns,
  );
}

export async function readableRevisions(
  db: Database,
  effectiveDb: Database,
  tenant: string,
  user: { id: string },
  q: RevisionQuery,
): Promise<{ rows: RevisionRow[]; total: number; scopes: Map<string, ReadScope> }> {
  const scopes = new Map<string, ReadScope>();
  const none = { rows: [], total: 0, scopes };
  if (q.id !== undefined && !isUuid(q.id)) return none;

  // ponytail: one readScope per collection the caller may read when no
  // `?collection=` is given — bounded by the registry, not by zv_revisions.
  const names = q.collection
    ? [q.collection]
    : (await DDLManager.getCollections(db)).map((c: { name: string }) => c.name);
  for (const name of names) {
    if (q.collection && !(await DDLManager.getCollection(db, name))) continue;
    if (!(await checkPermission(user.id, name, 'read'))) continue;
    scopes.set(name, await readScope(db, name, user, 'session'));
  }
  if (scopes.size === 0) return none;

  const visible = [...scopes].map(([name, scope]) => {
    if (scope.rls.length === 0 && !scope.altersRestrict) return sql`r.collection = ${name}`;
    // The live row, through the caller's row rules and alters. `record_id` is
    // text; the guarded cast keeps the probe on the primary key.
    const live = scope.query(
      dynamicDb(effectiveDb)
        .selectFrom(scope.table)
        .select(sql`1`.as('one'))
        .where(
          sql.ref(`${scope.table}.id`),
          '=',
          sql`CASE WHEN r.record_id ~* ${UUID_PATTERN} THEN r.record_id::uuid END`,
        ),
    );
    return sql`(r.collection = ${name} AND EXISTS ${live})`;
  });

  const where = sql`r.tenant_id = ${tenant}::uuid AND (${sql.join(visible, sql` OR `)})
    ${q.id ? sql`AND r.id = ${q.id}::uuid` : sql``}
    ${q.record_id ? sql`AND r.record_id = ${q.record_id}` : sql``}
    ${q.user_id ? sql`AND r.user_id = ${q.user_id}` : sql``}
    ${q.action ? sql`AND r.action = ${q.action}` : sql``}`;

  const found = await sql<RevisionRow>`
    SELECT r.*, u.name AS user_name, u.email AS user_email
      FROM zv_revisions r
      LEFT JOIN "user" u ON u.id = r.user_id
     WHERE ${where}
     ORDER BY r.created_at DESC
     LIMIT ${q.limit} OFFSET ${q.offset}`.execute(effectiveDb);

  const rows: RevisionRow[] = [];
  for (const row of found.rows) {
    const scope = scopes.get(row.collection)!;
    // Entity access is a callback, not SQL: asked per row on this page.
    // ponytail: one lookup per row, and `total` does not subtract the refusals;
    // batch per collection if an entity check ever sits on a hot audit list.
    if (entityAccessRegistry.hasChecksFor(scope.table)) {
      const live = isUuid(row.record_id)
        ? await scope
            .query(
              dynamicDb(effectiveDb)
                .selectFrom(scope.table)
                .selectAll()
                .where('id', '=', row.record_id),
            )
            .executeTakeFirst()
        : undefined;
      if ((await scope.keep([live ?? asObject(row.data)])).length === 0) continue;
    }
    rows.push({
      ...row,
      data: await shapeRevisionData(db, scope, row.collection, row.data),
      delta:
        row.delta == null ? null : await shapeRevisionData(db, scope, row.collection, row.delta),
    });
  }

  let total = rows.length;
  if (q.total) {
    const counted = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM zv_revisions r WHERE ${where}`.execute(effectiveDb);
    total = Number(counted.rows[0]?.count ?? 0);
  }
  return { rows, total, scopes };
}

/**
 * The PATCH body that takes a record back to a revision: the revision as the
 * caller reads it (`row.data` from `readableRevisions`, hidden columns already
 * shaped out), minus the system columns and the fields that already hold that
 * value — so a read-only column that did not move does not refuse the revert.
 * The write itself is the data API's PATCH, which checks the rest.
 */
export async function revertPatch(
  effectiveDb: Database,
  scope: ReadScope,
  revision: RevisionRow,
): Promise<Record<string, unknown>> {
  const live: Record<string, unknown> = isUuid(revision.record_id)
    ? ((await dynamicDb(effectiveDb)
        .selectFrom(scope.table)
        .selectAll()
        .where('id', '=', revision.record_id)
        .executeTakeFirst()) ?? {})
    : {};
  const json = (v: unknown) =>
    JSON.stringify(v ?? null, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(revision.data)) {
    if (SYSTEM_COLUMNS.has(k) || k === 'embedding') continue;
    if (json(v) !== json(live[k])) patch[k] = v;
  }
  return patch;
}

/**
 * Bulk write handlers (H-05 split of `routes/data.ts`):
 *   POST   /:collection/bulk — bulk insert
 *   PATCH  /:collection/bulk — bulk partial update
 *   DELETE /:collection/bulk — bulk delete
 *
 * Each runs per-row pre-write hooks inside a single transaction (abort → per-row
 * error), then fires `afterWrite` side-effects per successful row. Byte-identical
 * to the pre-split inline handlers — zero behaviour change.
 */

import type { Context } from 'hono';
import type { Database } from '../../../db/index.js';
import type { DynamicRecord } from '../../../db/dynamic-types.js';
import { DDLManager } from '../ddl-manager.js';
import { engineEvents, AbortHookError } from '../../runtime/index.js';
import { dynamicInsert, dynamicUpdate } from '../../../db/dynamic.js';
import {
  processInput,
  afterWrite,
  getDb,
  handlePgErrors,
  getTenantId,
  dynamicDb,
  runAtomic,
  isUuid,
} from '../write-pipeline.js';
import { queryAlterRegistry } from '../query-alter.js';
import { checkAccess } from '../auth.js';
import {
  getColumnAccess,
  filterWritableFields,
  entityAccessRegistry,
  getRlsFilters,
  applyRlsFilters,
  resolveUserRole,
} from '../../tenancy/index.js';

export async function bulkCreate(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'create'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.records) || body.records.length === 0) {
    return c.json({ error: 'Body must be { records: [...] } with at least one item' }, 400);
  }
  if (body.records.length > 500) {
    return c.json({ error: 'Bulk insert limited to 500 records per request' }, 400);
  }

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);
  // Column-level write permission — mirror single createRecord. Without it the
  // bulk endpoint was an escalation hole around read-only columns.
  const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user));
  const created: DynamicRecord[] = [];
  const errors: Array<{ index: number; errors: string[] }> = [];

  // Per-row pre-insert hook. A hook abort becomes a per-row error so the
  // rest of the batch still proceeds. Non-abort exceptions roll back the
  // entire transaction (something is genuinely wrong).
  // A constraint violation inside the batch is a 4xx, as it is on the
  // single-record routes. Unwrapped it escaped as a 500 that named neither the
  // constraint nor the column, for the same duplicate that answers 409 through
  // `POST /:collection`.
  //
  // The batch still rolls back whole: the throw leaves `runAtomic`, and Postgres
  // has aborted the transaction by then anyway. Reporting one bad row in the
  // per-row `errors` array and keeping the rest needs a SAVEPOINT around each
  // row -- a real change to what this endpoint promises, and not this one.
  const failed = await handlePgErrors(c, async () => {
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { errors: valErrors, processed } = await processInput(body.records[i], collectionDef);
        if (valErrors.length > 0) {
          errors.push({ index: i, errors: valErrors });
          continue;
        }

        const { data: writable, blocked } = filterWritableFields(processed, colAccess);
        if (blocked.length > 0) {
          errors.push({
            index: i,
            errors: [`Fields are read-only for your role: ${blocked.join(', ')}`],
          });
          continue;
        }

        let finalInsert: Record<string, unknown>;
        try {
          const hooked = await engineEvents.runBefore('record.beforeInsert', {
            collection,
            // Same as the single-record path: authorship is engine-supplied and
            // goes in as `system` below, not through a payload a hook can
            // rewrite. Merged here before and stripped by RESERVED, so
            // bulk-created rows landed with NULL authorship too.
            data: { ...writable },
            userId: user.id,
          });
          finalInsert = hooked.data;
        } catch (err) {
          if (err instanceof AbortHookError) {
            errors.push({ index: i, errors: [`EXT_HOOK_ABORTED: ${err.reason}`] });
            continue;
          }
          throw err;
        }

        const record = await dynamicInsert(trx, tableName, finalInsert, {
          created_by: user.id,
          updated_by: user.id,
        });
        created.push(record as DynamicRecord);
      }
    });
    return null;
  });
  if (failed) return failed as Response;

  const tid = getTenantId(c);
  // Awaited, as the single-record path already does.
  //
  // Not awaiting looked like the cheap choice — these are side effects and the
  // rows are written. But `afterWrite` hands the request's transaction to
  // `triggerDataFlows`, and an un-awaited call races the commit and loses:
  // measured, every bulk create logged `trigger "insert" … did not run its
  // automations: Transaction is already committed`, while the same write through
  // `POST /api/data/:collection` and through `PATCH` was clean.
  //
  // So automations never fired for records created in a batch — which is
  // precisely when an import or a sync uses this endpoint, and the operator sees
  // the single-record case work. The failure announced itself in the log and
  // nowhere else.
  //
  // The cost is that the response waits for the fan-out of a batch rather than a
  // row. That is the same cost the single path already pays, and the alternative
  // is a side effect whose handle is gone before it runs.
  for (const record of created) {
    await afterWrite(effectiveDb, {
      collection,
      recordId: record.id,
      action: 'create',
      data: record,
      userId: user.id,
      tenantId: tid,
    }).catch((err: Error) => {
      console.warn(`[data] afterWrite(create, ${collection}/${record.id}) failed:`, err.message);
    });
  }

  return c.json(
    { created: created.length, records: created, errors },
    errors.length > 0 ? 207 : 201,
  );
}

export async function bulkUpdate(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.records) || body.records.length === 0) {
    return c.json({ error: 'Body must be { records: [{id, ...fields}] }' }, 400);
  }
  if (body.records.length > 500) {
    return c.json({ error: 'Bulk update limited to 500 records per request' }, 400);
  }
  if (body.records.some((r: { id?: unknown }) => !isUuid(String(r?.id)))) {
    return c.json({ error: 'Every record must have a valid UUID id' }, 400);
  }

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);
  // Resolved once for the whole batch — the conditions depend on the caller,
  // not the row.
  const rlsFilters = await getRlsFilters(collection, user, c.get('authType'));
  // Column-level write permission — mirror single patchRecord.
  const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user));
  const updated: DynamicRecord[] = [];
  const errors: Array<{ index: number; id: string; errors: string[] }> = [];

  // Per-row pre-update hook. Before-row fetched inside the transaction so
  // a concurrent write between read and update is at least visible in the
  // same tx snapshot. Hook abort becomes a per-row error.
  // A constraint violation inside the batch is a 4xx, as it is on the
  // single-record routes. Unwrapped it escaped as a 500 that named neither the
  // constraint nor the column, for the same duplicate that answers 409 through
  // `POST /:collection`.
  //
  // The batch still rolls back whole: the throw leaves `runAtomic`, and Postgres
  // has aborted the transaction by then anyway. Reporting one bad row in the
  // per-row `errors` array and keeping the rest needs a SAVEPOINT around each
  // row -- a real change to what this endpoint promises, and not this one.
  const failed = await handlePgErrors(c, async () => {
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { id, ...fields } = body.records[i];
        const { errors: valErrors, processed } = await processInput(fields, collectionDef, true);
        if (valErrors.length > 0) {
          errors.push({ index: i, id, errors: valErrors });
          continue;
        }

        const { data: writable, blocked } = filterWritableFields(processed, colAccess);
        if (blocked.length > 0) {
          errors.push({
            index: i,
            id,
            errors: [`Fields are read-only for your role: ${blocked.join(', ')}`],
          });
          continue;
        }

        // RLS conditions on the row we load, so a row the caller cannot see is
        // reported as not found rather than updated. bulk.ts applied no RLS at
        // all, which made it the easy way around the single-record path.
        //
        // Extension query alters go on the same SELECT, as the single-record path
        // does on its own before-row: "Apply query alters so a row hidden by an
        // extension filter cannot be deleted by ID". They were the third guard of
        // three, and the only one this file did not mirror -- so a row an
        // extension hid (soft-delete, tenant isolation) answered 404 to
        // `PATCH /:id` and was rewritten by `PATCH /bulk`. Measured, both.
        const beforeRow = await queryAlterRegistry
          .applyAll(
            applyRlsFilters(
              dynamicDb(trx).selectFrom(tableName).selectAll().where('id', '=', id),
              rlsFilters,
            ),
            tableName,
            user,
          )
          .executeTakeFirst();
        if (!beforeRow) {
          errors.push({ index: i, id, errors: ['Record not found'] });
          continue;
        }

        // Per-row entity-access — mirror single patchRecord/replaceRecord. Without
        // it, bulk update let a user modify rows they have no row-level access to.
        if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
          errors.push({ index: i, id, errors: ['Forbidden'] });
          continue;
        }

        let finalPatch: Record<string, unknown>;
        try {
          const hooked = await engineEvents.runBefore('record.beforeUpdate', {
            collection,
            id,
            before: beforeRow,
            patch: { ...writable, updated_by: user.id },
            userId: user.id,
          });
          finalPatch = hooked.patch;
        } catch (err) {
          if (err instanceof AbortHookError) {
            errors.push({ index: i, id, errors: [`EXT_HOOK_ABORTED: ${err.reason}`] });
            continue;
          }
          throw err;
        }

        const record = await dynamicUpdate(trx, tableName, id, finalPatch, {
          updated_by: user.id,
        });
        if (record) updated.push(record as DynamicRecord);
        else errors.push({ index: i, id, errors: ['Record not found'] });
      }
    });
    return null;
  });
  if (failed) return failed as Response;

  const tid = getTenantId(c);
  // Awaited, for the reason recorded on the create path above: an un-awaited
  // call hands `triggerDataFlows` a transaction that commits before it runs.
  for (const record of updated) {
    await afterWrite(effectiveDb, {
      collection,
      recordId: record.id,
      action: 'update',
      data: record,
      userId: user.id,
      tenantId: tid,
    }).catch((err: Error) => {
      console.warn(`[data] afterWrite(update, ${collection}/${record.id}) failed:`, err.message);
    });
  }

  return c.json(
    { updated: updated.length, records: updated, errors },
    errors.length > 0 ? 207 : 200,
  );
}

export async function bulkDelete(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'delete'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!(await DDLManager.getCollection(db, collection))) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.ids) || body.ids.length === 0) {
    return c.json({ error: 'Body must be { ids: [...] }' }, 400);
  }
  if (body.ids.length > 500) {
    return c.json({ error: 'Bulk delete limited to 500 records per request' }, 400);
  }
  if (body.ids.some((id: unknown) => !isUuid(String(id)))) {
    return c.json({ error: 'All ids must be valid UUIDs' }, 400);
  }

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);

  // Same RLS conditions as the single delete path — rows the caller cannot see
  // never enter the delete set.
  // ...and the extension query alters the single delete path applies to its own
  // lookup. A row hidden by an alter never enters the delete set; without this
  // the batch endpoint deleted rows `DELETE /:id` answers 404 for.
  const existing = await queryAlterRegistry
    .applyAll(
      applyRlsFilters(
        dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', 'in', body.ids),
        await getRlsFilters(collection, user, c.get('authType')),
      ),
      tableName,
      user,
    )
    .execute();

  // Per-row pre-delete hook. Aborted IDs drop out of the delete set and
  // are reported back as per-row errors (so the caller can distinguish
  // them from rows that didn't exist).
  const aborted: Array<{ id: string; reason: string }> = [];
  const forbidden: string[] = [];
  const allowed: DynamicRecord[] = [];
  for (const record of existing) {
    // Per-row entity-access — mirror single deleteRecord. Without it, bulk
    // delete let a user delete rows they have no row-level access to.
    if (!(await entityAccessRegistry.isAllowed(tableName, record, user, 'delete'))) {
      forbidden.push(record.id);
      continue;
    }
    try {
      await engineEvents.runBefore('record.beforeDelete', {
        collection,
        id: record.id,
        record,
        userId: user.id,
      });
      allowed.push(record);
    } catch (err) {
      if (err instanceof AbortHookError) {
        aborted.push({ id: record.id, reason: err.reason });
      } else {
        throw err;
      }
    }
  }

  if (allowed.length > 0) {
    // A foreign key that refuses one of these rows is a 422, not a 500 -- the
    // single delete path says so too.
    const failed = await handlePgErrors(c, async () => {
      await dynamicDb(effectiveDb)
        .deleteFrom(tableName)
        .where(
          'id',
          'in',
          allowed.map((r) => r.id),
        )
        .execute();
      return null;
    });
    if (failed) return failed as Response;

    const tid = getTenantId(c);
    // Awaited, for the reason recorded on the create path above: an un-awaited
    // call hands `triggerDataFlows` a transaction that commits before it runs.
    for (const record of allowed) {
      await afterWrite(effectiveDb, {
        collection,
        recordId: record.id,
        action: 'delete',
        data: record,
        userId: user.id,
        tenantId: tid,
      }).catch((err: Error) => {
        console.warn(`[data] afterWrite(delete, ${collection}/${record.id}) failed:`, err.message);
      });
    }
  }

  return c.json(
    {
      deleted: allowed.length,
      ids: allowed.map((r) => r.id),
      ...(aborted.length > 0 ? { aborted } : {}),
      ...(forbidden.length > 0 ? { forbidden } : {}),
    },
    aborted.length > 0 || forbidden.length > 0 ? 207 : 200,
  );
}

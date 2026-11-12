/**
 * Bulk write handlers (H-05 split of `routes/data.ts`):
 *   POST   /:collection/bulk — bulk insert
 *   PATCH  /:collection/bulk — bulk partial update
 *   DELETE /:collection/bulk — bulk delete
 *
 * Each checks every row (validation, column access, row rules, entity access,
 * transitions, pre-write hooks) in the request's transaction, then fires
 * `afterWrite` per row and enqueues the batch's change events (webhooks, flows)
 * in that same transaction (ADR 0035). A batch is all or nothing (ADR 0044): one
 * refused row refuses it, and the answer names every refused row.
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
  selectReadable,
  runAtomic,
  isUuid,
  engineRead,
  hasTransitionRules,
  validateTransitions,
  ROW_RULE_WRITE_REFUSAL,
} from '../write-pipeline.js';
import { type ChangeEvent, enqueueChangeEvent } from '../../webhooks.js';
import { queryAlterRegistry } from '../query-alter.js';
import { serializeRecord } from '../shape.js';
import { problem } from '../../problem.js';
import { rowAuthorId, checkAccess } from '../auth.js';
import { cascadeRefusal, writtenByBody, writtenByRefusal } from '../written-by.js';
import {
  getColumnAccess,
  filterWritableFields,
  entityAccessRegistry,
  getRlsFilters,
  applyRlsFilters,
  matchesRlsFilters,
  resolveUserRole,
} from '../../tenancy/index.js';

type Refusal = { index: number; id?: string; errors: string[] };

/**
 * A refused row refuses the batch (ADR 0044): 422 `bulk_refused`, every refused
 * row in `errors`. Thrown, not returned: the tenant middleware commits a request
 * whose handler returned, so only a throw rolls back the rows, revisions and
 * outbox jobs written before the refusal, and drops their after-commit events.
 */
function refuseBatch(errors: Refusal[]): never {
  throw problem(
    'bulk_refused',
    422,
    'A refused row refuses the whole batch; nothing was written',
    errors,
  );
}

/** Every key some record of a batch sends. */
const sentKeys = (records: unknown[]): string[] =>
  records.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : []));

/**
 * `afterWrite` for each written row, then their change events as one batch, on
 * the batch's own transaction (ADR 0035).
 *
 * Awaited, as the single-record path already does. Not awaiting looked like the
 * cheap choice, but an un-awaited call raced the commit and lost: measured,
 * every bulk create logged `trigger "insert" … did not run its automations:
 * Transaction is already committed`, so automations never fired for records
 * created in a batch — precisely when an import or a sync uses these endpoints.
 *
 * The rows are written, so a failed side effect is logged, not answered. The
 * event enqueue is not one of those: its failure is the write's (503,
 * `webhooks.enqueue_failed` or `flows.enqueue_failed`) and rolls the whole batch
 * back.
 */
async function afterBulkWrite(
  c: Context,
  trx: Database,
  collection: string,
  action: 'create' | 'update' | 'delete',
  records: DynamicRecord[],
): Promise<void> {
  const user = c.get('user');
  const tenantId = getTenantId(c);
  const events: ChangeEvent[] = [];
  for (const record of records) {
    await afterWrite(trx, {
      collection,
      recordId: record.id,
      action,
      data: record,
      userId: user.id,
      author: rowAuthorId(user),
      tenantId,
      events,
    }).catch((err: Error) => {
      console.warn(`[data] afterWrite(${action}, ${collection}/${record.id}) failed:`, err.message);
    });
  }
  await enqueueChangeEvent(trx, tenantId, events);
}

export async function bulkCreate(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');
  const author = rowAuthorId(user);

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
  // No action writes in bulk: a flagged collection, or a flagged field in any record, refuses all.
  const refused = writtenByRefusal(collectionDef, undefined, sentKeys(body.records));
  if (refused) return c.json(writtenByBody(refused), 409);

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);
  // Column-level write permission — mirror single createRecord. Without it the
  // bulk endpoint was an escalation hole around read-only columns.
  const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user), user);
  // Create without read: ids only in the answer (see `engineRead`).
  const canRead = await checkAccess(db, user, collection, 'read');
  const created: DynamicRecord[] = [];
  const errors: Refusal[] = [];

  // Every row is checked, so the refusal names all of them; a hook abort is one
  // more refused row. A non-abort exception is a fault and propagates.
  // A constraint violation inside the batch is a 4xx, as it is on the
  // single-record routes (409 for a duplicate), and rolls the batch back: the
  // throw leaves the handler, and Postgres has aborted the transaction anyway.
  // After the first refusal no row is written: the batch rolls back regardless,
  // and a write could only abort the transaction and hide the later refusals.
  const failed = await handlePgErrors(c, async () => {
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { errors: valErrors, processed } = await processInput(
          body.records[i],
          collectionDef,
          false,
          null,
        );
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
        const late = writtenByRefusal(collectionDef, undefined, Object.keys(finalInsert));
        if (late) {
          errors.push({ index: i, errors: [late] });
          continue;
        }

        if (errors.length > 0) continue;
        const system = { created_by: author, updated_by: author };
        const record = await engineRead(canRead, trx, collection, () =>
          dynamicInsert(trx, tableName, finalInsert, system),
        );
        created.push(record as DynamicRecord);
      }
      if (errors.length === 0) await afterBulkWrite(c, trx, collection, 'create', created);
    });
    return null;
  });
  if (failed) return failed as Response;
  if (errors.length > 0) refuseBatch(errors);

  return c.json(
    {
      created: created.length,
      records: canRead
        ? await Promise.all(created.map((r) => serializeRecord(r, collectionDef, colAccess)))
        : created.map((r) => ({ id: r.id })),
      errors,
    },
    201,
  );
}

export async function bulkUpdate(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');
  const author = rowAuthorId(user);

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
  const refused = writtenByRefusal(collectionDef, undefined, sentKeys(body.records));
  if (refused) return c.json(writtenByBody(refused), 409);

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);
  // Resolved once for the whole batch — the conditions depend on the caller,
  // not the row.
  const rlsFilters = await getRlsFilters(collection, user, c.get('authType'), 'read');
  const writeRules = await getRlsFilters(collection, user, c.get('authType'), 'update');
  // Column-level write permission — mirror single patchRecord.
  const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user), user);
  // Update without read: the engine reads in the window, the answer names rows.
  const canRead = await checkAccess(db, user, collection, 'read');
  const updated: DynamicRecord[] = [];
  const errors: Refusal[] = [];

  // Before-row fetched inside the transaction so a concurrent write between
  // read and update is at least visible in the same tx snapshot. Every row is
  // checked; a hook abort is one more refused row. A constraint violation is a
  // 4xx as on the single-record routes, and rolls the batch back. After the
  // first refusal no row is written (see bulkCreate).
  const failed = await handlePgErrors(c, async () => {
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { id, ...fields } = body.records[i];
        const { errors: valErrors, processed } = await processInput(
          fields,
          collectionDef,
          true,
          'later',
        );
        if (valErrors.length > 0) {
          errors.push({ index: i, id, errors: valErrors });
          continue;
        }
        const transitions = await hasTransitionRules(collectionDef, processed);

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
        const beforeQuery = queryAlterRegistry.applyAll(
          applyRlsFilters((await selectReadable(trx, tableName)).where('id', '=', id), rlsFilters),
          tableName,
          user,
        );
        const beforeRow = await engineRead<DynamicRecord | undefined>(
          canRead,
          trx,
          collection,
          () => beforeQuery.executeTakeFirst(),
        );
        if (!beforeRow) {
          errors.push({ index: i, id, errors: ['Record not found'] });
          continue;
        }
        // Readable under the exemption, not writable under the rules (ADR 0037).
        if (!matchesRlsFilters(beforeRow, writeRules)) {
          errors.push({ index: i, id, errors: [ROW_RULE_WRITE_REFUSAL.error] });
          continue;
        }

        // Per-row entity-access — mirror single patchRecord/replaceRecord. Without
        // it, bulk update let a user modify rows they have no row-level access to.
        if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
          errors.push({ index: i, id, errors: ['Forbidden'] });
          continue;
        }
        if (transitions) {
          const transitionErrors = await validateTransitions(
            trx,
            canRead,
            collectionDef,
            id,
            processed,
            () => beforeQuery.executeTakeFirst(),
          );
          if (transitionErrors.length > 0) {
            errors.push({ index: i, id, errors: transitionErrors });
            continue;
          }
        }

        let finalPatch: Record<string, unknown>;
        try {
          const hooked = await engineEvents.runBefore('record.beforeUpdate', {
            collection,
            id,
            before: beforeRow,
            patch: { ...writable, updated_by: author },
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
        const late = writtenByRefusal(collectionDef, undefined, Object.keys(finalPatch));
        if (late) {
          errors.push({ index: i, id, errors: [late] });
          continue;
        }

        if (errors.length > 0) continue;
        const system = { updated_by: author };
        const record = await engineRead(canRead, trx, collection, () =>
          dynamicUpdate(trx, tableName, id, finalPatch, system),
        );
        if (record) updated.push(record as DynamicRecord);
        else errors.push({ index: i, id, errors: ['Record not found'] });
      }
      if (errors.length === 0) await afterBulkWrite(c, trx, collection, 'update', updated);
    });
    return null;
  });
  if (failed) return failed as Response;
  if (errors.length > 0) refuseBatch(errors);

  return c.json(
    {
      updated: updated.length,
      records: canRead
        ? await Promise.all(updated.map((r) => serializeRecord(r, collectionDef, colAccess)))
        : updated.map((r) => ({ id: r.id })),
      errors,
    },
    200,
  );
}

export async function bulkDelete(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'delete'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);
  const refused =
    writtenByRefusal(collectionDef, undefined, null) ??
    (await cascadeRefusal(collection, undefined, getDb(c, db)));
  if (refused) return c.json(writtenByBody(refused), 409);

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
  // Delete without read: the lookup and the DELETE run in the read window.
  const canRead = await checkAccess(db, user, collection, 'read');

  // Same RLS conditions as the single delete path — rows the caller cannot see
  // never enter the delete set.
  // ...and the extension query alters the single delete path applies to its own
  // lookup. A row hidden by an alter never enters the delete set; without this
  // the batch endpoint deleted rows `DELETE /:id` answers 404 for.
  const deleteFilters = await getRlsFilters(collection, user, c.get('authType'), 'read');
  const writeRules = await getRlsFilters(collection, user, c.get('authType'), 'delete');
  const existing = await engineRead<DynamicRecord[]>(canRead, effectiveDb, collection, async () =>
    queryAlterRegistry
      .applyAll(
        applyRlsFilters(
          (await selectReadable(effectiveDb, tableName)).where('id', 'in', body.ids),
          deleteFilters,
        ),
        tableName,
        user,
      )
      .execute(),
  );

  // Every id is checked, so the refusal names all of them (ADR 0044): one the
  // caller cannot see is not found, as `DELETE /:id` answers 404 for it.
  const found = new Map(existing.map((r) => [String(r.id), r]));
  const seen = new Set<string>();
  const errors: Refusal[] = [];
  const allowed: DynamicRecord[] = [];
  for (const [index, sent] of (body.ids as unknown[]).entries()) {
    const id = String(sent);
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const record = found.get(key);
    if (!record) {
      errors.push({ index, id, errors: ['Record not found'] });
      continue;
    }
    // The row rules a read exemption stood down (ADR 0037), then per-row
    // entity-access — mirror single deleteRecord.
    if (!matchesRlsFilters(record, writeRules)) {
      errors.push({ index, id, errors: [ROW_RULE_WRITE_REFUSAL.error] });
      continue;
    }
    if (!(await entityAccessRegistry.isAllowed(tableName, record, user, 'delete'))) {
      errors.push({ index, id, errors: ['Forbidden'] });
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
      if (!(err instanceof AbortHookError)) throw err;
      errors.push({ index, id, errors: [`EXT_HOOK_ABORTED: ${err.reason}`] });
    }
  }
  if (errors.length > 0) refuseBatch(errors);

  // A foreign key that refuses one of these rows is a 422, not a 500 -- the
  // single delete path says so too.
  const failed = await handlePgErrors(c, async () => {
    await runAtomic(effectiveDb, async (trx: Database) => {
      const gone = await engineRead<{ id: string }[]>(canRead, trx, collection, () =>
        dynamicDb(trx)
          .deleteFrom(tableName)
          .where(
            'id',
            'in',
            allowed.map((r) => r.id),
          )
          .returning('id')
          .execute(),
      );
      // Only the rows this statement removed: one a concurrent delete took
      // first has had its event already.
      const ids = new Set(gone.map((r) => r.id));
      await afterBulkWrite(
        c,
        trx,
        collection,
        'delete',
        allowed.filter((r) => ids.has(r.id)),
      );
    });
    return null;
  });
  if (failed) return failed as Response;

  return c.json({ deleted: allowed.length, ids: allowed.map((r) => r.id) }, 200);
}

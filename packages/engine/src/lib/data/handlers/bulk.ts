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
  getTenantId,
  dynamicDb,
  runAtomic,
  isUuid,
} from '../write-pipeline.js';
import { checkAccess } from '../auth.js';

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
  const created: DynamicRecord[] = [];
  const errors: Array<{ index: number; errors: string[] }> = [];

  // Per-row pre-insert hook. A hook abort becomes a per-row error so the
  // rest of the batch still proceeds. Non-abort exceptions roll back the
  // entire transaction (something is genuinely wrong).
  await runAtomic(effectiveDb, async (trx: Database) => {
    for (let i = 0; i < body.records.length; i++) {
      const { errors: valErrors, processed } = await processInput(body.records[i], collectionDef);
      if (valErrors.length > 0) {
        errors.push({ index: i, errors: valErrors });
        continue;
      }

      let finalInsert: Record<string, unknown>;
      try {
        const hooked = await engineEvents.runBefore('record.beforeInsert', {
          collection,
          data: { ...processed, created_by: user.id, updated_by: user.id },
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

      const record = await dynamicInsert(trx, tableName, finalInsert);
      created.push(record as DynamicRecord);
    }
  });

  const tid = getTenantId(c);
  for (const record of created) {
    afterWrite(effectiveDb, {
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
  const updated: DynamicRecord[] = [];
  const errors: Array<{ index: number; id: string; errors: string[] }> = [];

  // Per-row pre-update hook. Before-row fetched inside the transaction so
  // a concurrent write between read and update is at least visible in the
  // same tx snapshot. Hook abort becomes a per-row error.
  await runAtomic(effectiveDb, async (trx: Database) => {
    for (let i = 0; i < body.records.length; i++) {
      const { id, ...fields } = body.records[i];
      const { errors: valErrors, processed } = await processInput(fields, collectionDef, true);
      if (valErrors.length > 0) {
        errors.push({ index: i, id, errors: valErrors });
        continue;
      }

      const beforeRow = await dynamicDb(trx)
        .selectFrom(tableName)
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!beforeRow) {
        errors.push({ index: i, id, errors: ['Record not found'] });
        continue;
      }

      let finalPatch: Record<string, unknown>;
      try {
        const hooked = await engineEvents.runBefore('record.beforeUpdate', {
          collection,
          id,
          before: beforeRow,
          patch: { ...processed, updated_by: user.id },
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

      const record = await dynamicUpdate(trx, tableName, id, finalPatch);
      if (record) updated.push(record as DynamicRecord);
      else errors.push({ index: i, id, errors: ['Record not found'] });
    }
  });

  const tid = getTenantId(c);
  for (const record of updated) {
    afterWrite(effectiveDb, {
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

  const existing = await dynamicDb(effectiveDb)
    .selectFrom(tableName)
    .selectAll()
    .where('id', 'in', body.ids)
    .execute();

  // Per-row pre-delete hook. Aborted IDs drop out of the delete set and
  // are reported back as per-row errors (so the caller can distinguish
  // them from rows that didn't exist).
  const aborted: Array<{ id: string; reason: string }> = [];
  const allowed: DynamicRecord[] = [];
  for (const record of existing) {
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
    await dynamicDb(effectiveDb)
      .deleteFrom(tableName)
      .where(
        'id',
        'in',
        allowed.map((r) => r.id),
      )
      .execute();

    const tid = getTenantId(c);
    for (const record of allowed) {
      afterWrite(effectiveDb, {
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
    },
    aborted.length > 0 ? 207 : 200,
  );
}

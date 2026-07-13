/**
 * Single-record handlers (H-05 split of `routes/data.ts`):
 *   GET    /:collection/:id — read (with time-travel + virtual + RLS + expand)
 *   POST   /:collection     — create
 *   PUT    /:collection/:id — replace
 *   PATCH  /:collection/:id — partial update
 *   DELETE /:collection/:id — delete
 *
 * Each enforces access + entity-access, runs pre/post write hooks, and maps
 * Postgres errors via `handlePgErrors`. Byte-identical to the pre-split inline
 * handlers — zero behaviour change.
 */

import type { Context } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../../db/index.js';
import { DDLManager } from '../ddl-manager.js';
import { engineEvents, AbortHookError } from '../../runtime/index.js';
import { queryAlterRegistry } from '../query-alter.js';
import { entityAccessRegistry } from '../../tenancy/index.js';
import { dynamicInsert, dynamicUpdate, dynamicDelete } from '../../../db/dynamic.js';
import { tracedQuery } from '../../runtime/index.js';
import { getRlsFilters } from '../../tenancy/index.js';
import { getColumnAccess, applyColumnAccess, filterWritableFields } from '../../tenancy/index.js';
import {
  virtualGetOne,
  virtualCreate,
  virtualUpdate,
  virtualDelete,
} from '../../virtual-collection-adapter.js';
import type { JsonValue } from '../types.js';
import { serializeRecord, resolveExpand, applyExpand, computeEtag } from '../shape.js';
import {
  processInput,
  afterWrite,
  handlePgErrors,
  getVirtualConfig,
  getDb,
  getTenantId,
  dynamicDb,
  isUuid,
} from '../write-pipeline.js';
import { checkAccess } from '../auth.js';

export async function getRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');
  const asOfRaw = c.req.query('as_of');

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'read'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // ── Time Travel: single record at a given point in time ────────
  if (asOfRaw) {
    const asOf = new Date(asOfRaw);
    if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

    // P0: use effectiveDb for tenant isolation in time-travel queries
    const effectiveDbTTSingle = getDb(c, db);
    const rev = await sql<{ action: string; data: JsonValue; created_at: string }>`
        SELECT action, data, created_at
        FROM zv_revisions
        WHERE collection = ${collection}
          AND record_id = ${id}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(effectiveDbTTSingle);

    if (rev.rows.length === 0)
      return c.json({ error: 'Record not found at this point in time' }, 404);
    if (rev.rows[0].action === 'delete')
      return c.json({ error: 'Record was deleted before this point in time' }, 404);

    const data =
      typeof rev.rows[0].data === 'string' ? JSON.parse(rev.rows[0].data) : rev.rows[0].data;
    return c.json({
      record: data,
      time_travel: { as_of: asOf.toISOString(), snapshot_at: rev.rows[0].created_at },
    });
  }

  // Virtual collection: proxy to external API
  const virtualConfigSingle = await getVirtualConfig(db, collection);
  if (virtualConfigSingle) {
    try {
      const record = await virtualGetOne(virtualConfigSingle, id);
      if (!record) return c.json({ error: 'Record not found' }, 404);
      return c.json({ record });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);

  // Build query with RLS conditions so a user cannot fetch a record
  // they're not allowed to see by guessing its ID.
  const rlsSingle = await getRlsFilters(collection, user, c.get('authType'));
  // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
  let recordQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);

  for (const { field, condition } of rlsSingle) {
    if (condition.op === 'eq') recordQuery = recordQuery.where(field, '=', condition.value);
    else if (condition.op === 'neq') recordQuery = recordQuery.where(field, '!=', condition.value);
  }

  // Apply extension query alters (tenant isolation, soft-delete, etc.)
  recordQuery = queryAlterRegistry.applyAll(recordQuery, tableName, user);

  const record = await recordQuery.executeTakeFirst();

  if (!record) return c.json({ error: 'Record not found' }, 404);

  // Per-record entity-access check. A 404 (not 403) hides whether the
  // record exists at all from a viewer without permission.
  if (!(await entityAccessRegistry.isAllowed(tableName, record, user, 'view'))) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const colAccess = await getColumnAccess(db, collection, user.role ?? 'public');
  const serializedRecord = applyColumnAccess(
    await serializeRecord(record, collectionDef),
    colAccess,
  );

  // Expand m2o relations on demand
  const singleExpand = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
  if (singleExpand.length > 0) {
    await applyExpand(effectiveDb, [serializedRecord], singleExpand);
  }

  // ETag + Cache-Control for single record
  const singleEtag = `"${await computeEtag([serializedRecord])}"`;
  c.header('ETag', singleEtag);
  c.header('Cache-Control', 'private, max-age=0, must-revalidate');
  c.header('Vary', 'Cookie, X-API-Key, Authorization');

  const ifNoneMatchSingle = c.req.header('If-None-Match');
  if (ifNoneMatchSingle && ifNoneMatchSingle === singleEtag) {
    return c.body(null, 304);
  }

  return c.json(serializedRecord);
}

export async function createRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'create'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy create to external API
  const virtualConfigCreate = await getVirtualConfig(db, collection);
  if (virtualConfigCreate) {
    try {
      const body = await c.req.json();
      const record = await virtualCreate(virtualConfigCreate, body);
      return c.json({ record }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const body = await c.req.json();

  const { errors, processed } = await processInput(body, collectionDef);
  if (errors.length > 0) return c.json({ errors }, 422);

  const colAccessCreate = await getColumnAccess(db, collection, user.role ?? 'public');
  const { data: allowedData, blocked: blockedCreate } = filterWritableFields(
    processed,
    colAccessCreate,
  );
  if (blockedCreate.length > 0) {
    return c.json(
      { error: `Fields are read-only for your role: ${blockedCreate.join(', ')}` },
      403,
    );
  }

  const effectiveDb = getDb(c, db);
  const toInsert = { ...allowedData, created_by: user.id, updated_by: user.id };

  // Pre-insert hooks: extensions can mutate the payload (e.g. geocode an
  // address, attach a computed score) or abort (e.g. quota check).
  let finalInsert: Record<string, unknown>;
  try {
    const hooked = await engineEvents.runBefore('record.beforeInsert', {
      collection,
      data: toInsert,
      userId: user.id,
    });
    finalInsert = hooked.data;
  } catch (err) {
    if (err instanceof AbortHookError) {
      return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
    }
    throw err;
  }

  const result = await handlePgErrors(c, async () => {
    const record = await tracedQuery(`${tableName}.create`, () =>
      dynamicInsert(effectiveDb, tableName, finalInsert),
    );
    await afterWrite(effectiveDb, {
      collection,
      recordId: record.id,
      action: 'create',
      data: record,
      userId: user.id,
      tenantId: getTenantId(c),
    });
    const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
    return c.json(serialized, 201);
  });
  return result as Response;
}

export async function replaceRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy update to external API
  const virtualConfigPut = await getVirtualConfig(db, collection);
  if (virtualConfigPut) {
    try {
      const body = await c.req.json();
      const record = await virtualUpdate(virtualConfigPut, id, body);
      return c.json({ record });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const body = await c.req.json();

  const { errors, processed } = await processInput(body, collectionDef);
  if (errors.length > 0) return c.json({ errors }, 422);

  // Column-level write permission — MUST mirror createRecord/patchRecord.
  // Without this, PUT was an escalation hole: a role denied write access to a
  // column could still overwrite it via replace, since POST and PATCH block it
  // but PUT did not.
  const colAccessPut = await getColumnAccess(db, collection, user.role ?? 'public');
  const { data: allowedPut, blocked: blockedPut } = filterWritableFields(processed, colAccessPut);
  if (blockedPut.length > 0) {
    return c.json({ error: `Fields are read-only for your role: ${blockedPut.join(', ')}` }, 403);
  }

  const effectiveDb = getDb(c, db);
  const toUpdate = { ...allowedPut, updated_by: user.id };

  // Pre-update hooks need the current row for the `before` field. Read it
  // once — if the record doesn't exist (or extension query alters hide it)
  // we short-circuit before invoking any hooks.
  let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  beforeQuery = queryAlterRegistry.applyAll(beforeQuery, tableName, user);
  const beforeRow = await beforeQuery.executeTakeFirst();
  if (!beforeRow) return c.json({ error: 'Record not found' }, 404);

  // Entity-access enforcement: a row visible to query-alter still needs
  // explicit permission to be modified. 403 distinguishes "you cannot
  // touch this row" from the 404 we'd return for a hidden row.
  if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let finalPatch: Record<string, unknown>;
  try {
    const hooked = await engineEvents.runBefore('record.beforeUpdate', {
      collection,
      id,
      before: beforeRow,
      patch: toUpdate,
      userId: user.id,
    });
    finalPatch = hooked.patch;
  } catch (err) {
    if (err instanceof AbortHookError) {
      return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
    }
    throw err;
  }

  const result = await handlePgErrors(c, async () => {
    const record = await tracedQuery(`${tableName}.update`, () =>
      dynamicUpdate(effectiveDb, tableName, id, finalPatch),
    );
    if (!record) return c.json({ error: 'Record not found' }, 404);
    await afterWrite(effectiveDb, {
      collection,
      recordId: id,
      action: 'update',
      data: record,
      userId: user.id,
      tenantId: getTenantId(c),
    });
    const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
    return c.json(serialized);
  });
  return result as Response;
}

export async function patchRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy patch to external API
  const virtualConfigPatch = await getVirtualConfig(db, collection);
  if (virtualConfigPatch) {
    try {
      const body = await c.req.json();
      const record = await virtualUpdate(virtualConfigPatch, id, body);
      return c.json({ record });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const body = await c.req.json();

  const { errors, processed } = await processInput(body, collectionDef, true);
  if (errors.length > 0) return c.json({ errors }, 422);

  const colAccessPatch = await getColumnAccess(db, collection, user.role ?? 'public');
  const { data: allowedPatch, blocked: blockedPatch } = filterWritableFields(
    processed,
    colAccessPatch,
  );
  if (blockedPatch.length > 0) {
    return c.json({ error: `Fields are read-only for your role: ${blockedPatch.join(', ')}` }, 403);
  }

  const effectiveDb = getDb(c, db);
  const toUpdate = { ...allowedPatch, updated_by: user.id };

  let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  beforeQuery = queryAlterRegistry.applyAll(beforeQuery, tableName, user);
  const beforeRow = await beforeQuery.executeTakeFirst();
  if (!beforeRow) return c.json({ error: 'Record not found' }, 404);

  if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let finalPatch: Record<string, unknown>;
  try {
    const hooked = await engineEvents.runBefore('record.beforeUpdate', {
      collection,
      id,
      before: beforeRow,
      patch: toUpdate,
      userId: user.id,
    });
    finalPatch = hooked.patch;
  } catch (err) {
    if (err instanceof AbortHookError) {
      return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
    }
    throw err;
  }

  const result = await handlePgErrors(c, async () => {
    const record = await dynamicUpdate(effectiveDb, tableName, id, finalPatch);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    await afterWrite(effectiveDb, {
      collection,
      recordId: id,
      action: 'update',
      data: record,
      delta: body,
      userId: user.id,
      tenantId: getTenantId(c),
    });
    const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
    return c.json(serialized);
  });
  return result as Response;
}

export async function deleteRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'delete'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy delete to external API
  const virtualConfigDelete = await getVirtualConfig(db, collection);
  if (virtualConfigDelete) {
    try {
      await virtualDelete(virtualConfigDelete, id);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  if (!(await DDLManager.getCollection(db, collection))) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);

  // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
  // Fetch existing for revision log, then delete atomically. Apply query
  // alters so a row hidden by an extension filter cannot be deleted by ID.
  let existingQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  existingQuery = queryAlterRegistry.applyAll(existingQuery, tableName, user);
  const existing = await existingQuery.executeTakeFirst();

  if (!existing) return c.json({ error: 'Record not found' }, 404);

  if (!(await entityAccessRegistry.isAllowed(tableName, existing, user, 'delete'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    await engineEvents.runBefore('record.beforeDelete', {
      collection,
      id,
      record: existing,
      userId: user.id,
    });
  } catch (err) {
    if (err instanceof AbortHookError) {
      return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
    }
    throw err;
  }

  const deleted = await tracedQuery(`${tableName}.delete`, () =>
    dynamicDelete(effectiveDb, tableName, id),
  );
  if (!deleted) return c.json({ error: 'Record not found' }, 404);

  await afterWrite(effectiveDb, {
    collection,
    recordId: id,
    action: 'delete',
    data: existing,
    userId: user.id,
    tenantId: getTenantId(c),
  });

  return c.json({ success: true, id });
}

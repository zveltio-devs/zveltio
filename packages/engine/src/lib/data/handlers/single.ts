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
import { queryAlterRegistry, TIME_TRAVEL_ALTERED } from '../query-alter.js';
import { entityAccessRegistry } from '../../tenancy/index.js';
import { dynamicInsert, dynamicUpdate, dynamicDelete } from '../../../db/dynamic.js';
import { tracedQuery } from '../../runtime/index.js';
import { getRlsFilters, applyRlsFilters, resolveUserRole } from '../../tenancy/index.js';
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
import { tenantId } from '../../route-db.js';
import { readScope } from '../read-scope.js';
import { rowAuthorId, checkAccess } from '../auth.js';
import type { RequestUser } from '../types.js';

/**
 * What a single-record write acts on, and as whom. The route builds it from its
 * own request (`routeWrite`); `ctx.internals` builds it from what the `/ext/*`
 * gate admitted, so an extension's write takes this path — the checks, the
 * hooks, `afterWrite` — as its caller and never as an identity it supplied.
 */
export interface WriteRequest {
  collection: string;
  id: string;
  body: () => Promise<Record<string, unknown>>;
  user: RequestUser;
  authType: 'session' | 'api_key';
  /** The request's tenant transaction; the handler's `db` when there is none. */
  trx: Database | undefined;
  tenantId: string | null;
}

function routeWrite(c: Context): WriteRequest {
  return {
    collection: c.req.param('collection')!,
    id: c.req.param('id') ?? '',
    body: () => c.req.json(),
    user: c.get('user'),
    authType: c.get('authType'),
    trx: c.get('tenantTrx') ?? undefined,
    tenantId: getTenantId(c),
  };
}

export async function getRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');
  const asOfRaw = c.req.query('as_of');

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'read'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Every row, column and extension rule this caller reads under.
  const scope = await readScope(db, collection, user, c.get('authType'));

  // ── Time Travel: single record at a given point in time ────────
  if (asOfRaw) {
    const asOf = new Date(asOfRaw);
    if (Number.isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

    // Before the revision is read, so the refusal says nothing about the record.
    if (scope.altersRestrict) {
      return c.json({ error: TIME_TRAVEL_ALTERED }, 403);
    }

    // P0: use effectiveDb for tenant isolation in time-travel queries
    const effectiveDbTTSingle = getDb(c, db);
    const rev = await sql<{ action: string; data: JsonValue; created_at: string }>`
        SELECT action, data, created_at
        FROM zv_revisions
        WHERE collection = ${collection}
          AND record_id = ${id}
          AND tenant_id = ${tenantId(c)}::uuid
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

    // Time travel MUST honour the same read authorization as the live read path
    // below — otherwise `?as_of=` is a bypass: a user denied entity-access to a
    // record, a row by policy, or read on a column, could read it from history.
    // In memory: the snapshot is JSON from `zv_revisions`, so there is no query
    // to attach a WHERE to.
    if (!(await scope.admits(data as Record<string, unknown>))) {
      return c.json({ error: 'Record not found' }, 404);
    }

    // The snapshot is the stored row: serialized as the live read below
    // serializes it, so a `password` hash stays out and an encrypted field
    // reads decrypted, not as `enc:v1:`.
    return c.json({
      record: await serializeRecord(
        data as Record<string, unknown>,
        await DDLManager.getCollection(db, collection),
        scope.columns,
      ),
      time_travel: { as_of: asOf.toISOString(), snapshot_at: rev.rows[0].created_at },
    });
  }

  // Virtual collection: proxy to external API
  const virtualConfigSingle = await getVirtualConfig(db, collection);
  if (virtualConfigSingle) {
    try {
      const record = await virtualGetOne(virtualConfigSingle, id);
      // Row policies, alters and entity access in memory, as for `?as_of=`:
      // the record comes from an upstream API, so there is no query to attach
      // them to. Only the columns were gated before — a row its policy hides
      // was served whole.
      if (!record || !(await scope.admits(record))) {
        return c.json({ error: 'Record not found' }, 404);
      }
      // Column permissions apply to virtual collections too — hide columns the
      // role can't read instead of proxying them through verbatim.
      return c.json({ record: scope.shape(record) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const effectiveDb = getDb(c, db);

  // Row policies and extension alters in the WHERE, so a user cannot fetch a
  // record they're not allowed to see by guessing its ID.
  // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
  const record = await scope
    .query(dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id))
    .executeTakeFirst();

  // Per-record entity-access check. A 404 (not 403) hides whether the
  // record exists at all from a viewer without permission.
  if (!record || (await scope.keep([record])).length === 0) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const serializedRecord = await serializeRecord(record, collectionDef, scope.columns);

  // Expand m2o relations on demand
  const singleExpand = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
  if (singleExpand.length > 0) {
    await applyExpand(
      effectiveDb,
      [serializedRecord],
      singleExpand,
      await resolveUserRole(user),
      user,
      c.get('authType'),
    );
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

export async function createRecord(
  c: Context,
  db: Database,
  w: WriteRequest = routeWrite(c),
): Promise<Response> {
  const { collection, user } = w;
  const author = rowAuthorId(user);

  if (!(await checkAccess(db, user, collection, 'create'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy create to external API
  const virtualConfigCreate = await getVirtualConfig(db, collection);
  if (virtualConfigCreate) {
    try {
      const body = await w.body();
      // Column-level write permission applies to virtual writes too.
      const vColAccess = await getColumnAccess(
        db,
        collection,
        await resolveUserRole(user),
        user.id,
      );
      const { data: writable, blocked } = filterWritableFields(body, vColAccess);
      if (blocked.length > 0) {
        return c.json({ error: `Fields are read-only for your role: ${blocked.join(', ')}` }, 403);
      }
      const record = await virtualCreate(virtualConfigCreate, writable);
      return c.json({ record: applyColumnAccess(record, vColAccess) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const body = await w.body();

  const { errors, processed } = await processInput(body, collectionDef);
  if (errors.length > 0) return c.json({ errors }, 422);

  const colAccessCreate = await getColumnAccess(
    db,
    collection,
    await resolveUserRole(user),
    user.id,
  );
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

  const effectiveDb = w.trx ?? db;
  // Authorship travels as `system` on the insert, not inside the payload. It
  // used to be merged here and then stripped by `dynamicInsert`'s RESERVED
  // filter, so every row landed with NULL authorship. Keeping it out of
  // `toInsert` also means a `record.beforeInsert` hook cannot rewrite it — the
  // hook already receives `userId` separately if it needs to know.
  const toInsert = { ...allowedData };
  const systemColumns = { created_by: author, updated_by: author };

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
      dynamicInsert(effectiveDb, tableName, finalInsert, systemColumns),
    );
    await afterWrite(effectiveDb, {
      collection,
      recordId: record.id,
      action: 'create',
      data: record,
      userId: user.id,
      author: rowAuthorId(user),
      tenantId: w.tenantId,
    });
    const serialized: Record<string, unknown> = await serializeRecord(
      record,
      collectionDef,
      colAccessCreate,
    );
    return c.json(serialized, 201);
  });
  return result as Response;
}

export async function replaceRecord(c: Context, db: Database): Promise<Response> {
  const collection = c.req.param('collection')!;
  const id = c.req.param('id')!;
  const user = c.get('user');
  const author = rowAuthorId(user);

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy update to external API
  const virtualConfigPut = await getVirtualConfig(db, collection);
  if (virtualConfigPut) {
    try {
      const body = await c.req.json();
      const vColAccess = await getColumnAccess(
        db,
        collection,
        await resolveUserRole(user),
        user.id,
      );
      const { data: writable, blocked } = filterWritableFields(body, vColAccess);
      if (blocked.length > 0) {
        return c.json({ error: `Fields are read-only for your role: ${blocked.join(', ')}` }, 403);
      }
      const record = await virtualUpdate(virtualConfigPut, id, writable);
      return c.json({ record: applyColumnAccess(record, vColAccess) });
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
  const colAccessPut = await getColumnAccess(db, collection, await resolveUserRole(user), user.id);
  const { data: allowedPut, blocked: blockedPut } = filterWritableFields(processed, colAccessPut);
  if (blockedPut.length > 0) {
    return c.json({ error: `Fields are read-only for your role: ${blockedPut.join(', ')}` }, 403);
  }

  const effectiveDb = getDb(c, db);
  const toUpdate = { ...allowedPut, updated_by: author };

  // Pre-update hooks need the current row for the `before` field. Read it
  // once — if the record doesn't exist (or extension query alters hide it)
  // we short-circuit before invoking any hooks.
  // Same authorisation probe as patchRecord: RLS conditions on the before-row,
  // so a row the caller cannot see cannot be replaced either.
  let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  beforeQuery = applyRlsFilters(
    beforeQuery,
    await getRlsFilters(collection, user, c.get('authType')),
  );
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
      dynamicUpdate(effectiveDb, tableName, id, finalPatch, { updated_by: author }),
    );
    if (!record) return c.json({ error: 'Record not found' }, 404);
    await afterWrite(effectiveDb, {
      collection,
      recordId: id,
      action: 'update',
      data: record,
      userId: user.id,
      author: rowAuthorId(user),
      tenantId: getTenantId(c),
    });
    const serialized: Record<string, unknown> = await serializeRecord(
      record,
      collectionDef,
      colAccessPut,
    );
    return c.json(serialized);
  });
  return result as Response;
}

export async function patchRecord(
  c: Context,
  db: Database,
  w: WriteRequest = routeWrite(c),
): Promise<Response> {
  const { collection, id, user } = w;
  const author = rowAuthorId(user);

  if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

  if (!(await checkAccess(db, user, collection, 'update'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Virtual collection: proxy patch to external API
  const virtualConfigPatch = await getVirtualConfig(db, collection);
  if (virtualConfigPatch) {
    try {
      const body = await w.body();
      const vColAccess = await getColumnAccess(
        db,
        collection,
        await resolveUserRole(user),
        user.id,
      );
      const { data: writable, blocked } = filterWritableFields(body, vColAccess);
      if (blocked.length > 0) {
        return c.json({ error: `Fields are read-only for your role: ${blocked.join(', ')}` }, 403);
      }
      const record = await virtualUpdate(virtualConfigPatch, id, writable);
      return c.json({ record: applyColumnAccess(record, vColAccess) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = await DDLManager.getCollection(db, collection);
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);
  const body = await w.body();

  const { errors, processed } = await processInput(body, collectionDef, true);
  if (errors.length > 0) return c.json({ errors }, 422);

  const colAccessPatch = await getColumnAccess(
    db,
    collection,
    await resolveUserRole(user),
    user.id,
  );
  const { data: allowedPatch, blocked: blockedPatch } = filterWritableFields(
    processed,
    colAccessPatch,
  );
  if (blockedPatch.length > 0) {
    return c.json({ error: `Fields are read-only for your role: ${blockedPatch.join(', ')}` }, 403);
  }

  const effectiveDb = w.trx ?? db;
  const toUpdate = { ...allowedPatch, updated_by: author };

  // The before-row fetch doubles as the authorisation probe: run the caller's
  // RLS conditions on it, so a row they are not allowed to see is simply not
  // found and the UPDATE never happens. Without this the policies applied to
  // reads only, and any member could patch another user's record by id.
  let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  beforeQuery = applyRlsFilters(beforeQuery, await getRlsFilters(collection, user, w.authType));
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
    const record = await dynamicUpdate(effectiveDb, tableName, id, finalPatch, {
      updated_by: author,
    });
    if (!record) return c.json({ error: 'Record not found' }, 404);
    await afterWrite(effectiveDb, {
      collection,
      recordId: id,
      action: 'update',
      data: record,
      // `finalPatch`, not `body`. The raw body is the one copy of the write
      // that has not been through `processInput`, so for a field declared
      // `encrypted: true` the column went to disk as `enc:v1:...` while the
      // revision kept what it was encrypted from, in the clear, on every PATCH.
      // Measured: the column matched `enc:v1:`, the delta held the plaintext.
      //
      // It is also the more truthful delta. The body is what the caller asked
      // for; `finalPatch` is what was written -- after column-access filtering
      // and after a `record.beforeUpdate` hook has had its say. The audit UI
      // labels this field "what changed".
      delta: finalPatch,
      userId: user.id,
      author: rowAuthorId(user),
      tenantId: w.tenantId,
    });
    const serialized: Record<string, unknown> = await serializeRecord(
      record,
      collectionDef,
      colAccessPatch,
    );
    return c.json(serialized);
  });
  return result as Response;
}

export async function deleteRecord(
  c: Context,
  db: Database,
  w: WriteRequest = routeWrite(c),
): Promise<Response> {
  const { collection, id, user } = w;

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
  const effectiveDb = w.trx ?? db;

  // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
  // Fetch existing for revision log, then delete atomically. Apply query
  // alters so a row hidden by an extension filter cannot be deleted by ID.
  let existingQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
  existingQuery = applyRlsFilters(existingQuery, await getRlsFilters(collection, user, w.authType));
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

  // Wrapped, like create, replace and patch above. Delete has its own
  // constraint to hit -- a foreign key from a child row -- and unwrapped it
  // escaped as a 500 saying nothing, where the same violation on the other three
  // routes answers 422 and names the field.
  const result = await handlePgErrors(c, async () => {
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
      author: rowAuthorId(user),
      tenantId: w.tenantId,
    });

    return c.json({ success: true, id });
  });
  return result as Response;
}

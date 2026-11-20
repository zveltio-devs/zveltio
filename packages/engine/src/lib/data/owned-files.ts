/**
 * ADR 0061 decision 2: a `file` field declared `ownsFile: true`.
 *
 * A file id enters such a field only when its writer could delete that file
 * (`claimRefusal`). From then on the row owns it: deleting the row, or writing
 * the field without it, deletes the stored file in the write's transaction and
 * its bytes once that commits (`releaseOwnedFiles`), with no further check —
 * the row's own rules decided who may delete or change it.
 *
 * Ceilings the owner accepted: two rows may claim one file (deleting one leaves
 * the other dangling), and the uploader can still delete it through the storage
 * API. A delete that does not go through the data API (a foreign key's cascade,
 * extension SQL), dropping the field, or a writer whose before-row withholds the
 * field (column rules) releases nothing: the file stays, never deleted wrongly.
 */

import type { Database } from '../../db/index.js';
import { DEFAULT_TENANT_ID } from '../route-db.js';
import { claimableFile, fileActorOf, type FileActor, releaseFiles } from '../stored-files.js';
import { onAfterCommit } from '../tenancy/index.js';
import { apiKeyHoldsScope, isApiKeyPrincipal, STORAGE_SCOPE } from './auth.js';
import { normalizeFields } from './shape.js';
import type { CollectionDef, RequestUser } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of `def` that own their files. */
export const ownedFileFields = (def: CollectionDef | null | undefined): string[] =>
  normalizeFields(def)
    .filter((f) => f.type === 'file' && f.ownsFile === true)
    .map((f) => f.name);

/**
 * The file ids a `file` value holds: `{ id, … }` or a list of them, or the JSON
 * text of one (a jsonb column may read back so). Null when it is neither.
 */
export function fileIdsOf(value: unknown): string[] | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v == null) return [];
  const ids: string[] = [];
  for (const f of Array.isArray(v) ? v : [v]) {
    const id = f !== null && typeof f === 'object' ? (f as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    ids.push(id.toLowerCase());
  }
  return ids;
}

/** Every file id the owned fields of `row` hold. */
const ownedIds = (fields: string[], row: Record<string, unknown> | null | undefined) =>
  new Set(fields.flatMap((f) => fileIdsOf(row?.[f]) ?? []));

/**
 * Why `user` may not write `payload` — the final values of a create or update,
 * after hooks — to a row of `def` that held `before` (none on a create), or null.
 * A file new to an owned field must be one `user` could delete; a file the row
 * already owned is not asked about again.
 */
export async function claimRefusal(
  db: Database,
  user: RequestUser,
  tenantId: string | null,
  def: CollectionDef | null | undefined,
  payload: Record<string, unknown>,
  before?: Record<string, unknown> | null,
): Promise<string | null> {
  const fields = ownedFileFields(def).filter((f) => payload[f] !== undefined);
  if (fields.length === 0) return null;
  const had = ownedIds(ownedFileFields(def), before);
  let actor: FileActor | undefined;
  // A key holds `$storage` delete to delete a file through `/api/storage`.
  const keyMayDelete =
    !isApiKeyPrincipal(user) || apiKeyHoldsScope(user.scopes, STORAGE_SCOPE, 'delete');
  for (const field of fields) {
    const ids = fileIdsOf(payload[field]);
    if (!ids) return `${field}: holds stored files by id ({ "id": … }, or a list of them)`;
    for (const id of ids) {
      if (had.has(id)) continue;
      actor ??= await fileActorOf(user, tenantId ?? DEFAULT_TENANT_ID);
      // One answer whether the file is missing, unreadable or not theirs to delete.
      if (!(await claimableFile(db, actor, id, keyMayDelete))) {
        return `${field}: file ${id} is not one you may delete, so this record cannot own it`;
      }
    }
  }
  return null;
}

/** The 403 a data API write answers when `claimRefusal` refuses it. */
export const claimRefusalBody = (error: string) => ({ error, code: 'file_not_claimable' });

/**
 * Release what `rows` owned: each `before` is a row as it was, `after` what the
 * write set on it (null: the row is gone). A file an owned field held before and
 * no owned field holds after is deleted in `db`, the write's transaction, and
 * its bytes once that commits. Call it after the write succeeded.
 */
export async function releaseOwnedFiles(
  db: Database,
  tenantId: string | null,
  def: CollectionDef | null | undefined,
  rows: Array<{ before: Record<string, unknown>; after: Record<string, unknown> | null }>,
): Promise<void> {
  const fields = ownedFileFields(def);
  if (fields.length === 0) return;
  const released = new Set<string>();
  for (const { before, after } of rows) {
    const kept = after ? ownedIds(fields, { ...before, ...after }) : new Set<string>();
    for (const id of ownedIds(fields, before)) if (!kept.has(id)) released.add(id);
  }
  await releaseFiles(db, tenantId ?? DEFAULT_TENANT_ID, [...released], (remove) =>
    onAfterCommit(remove),
  );
}

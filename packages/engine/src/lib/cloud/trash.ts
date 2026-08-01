import type { Database } from '../../db/index.js';

/**
 * Soft-deletes a media file by setting deleted_at.
 * Throws if the file is not found or already deleted.
 *
 * `tenantId` scopes the update so a caller can't trash another tenant's file by
 * id (zv_media_files has no RLS). Optional so the extension passthrough keeps its
 * signature; route handlers MUST pass it.
 */
export async function moveToTrash(
  db: Database,
  fileId: string,
  _deletedBy: string,
  tenantId?: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  let q = (db as any)
    .updateTable('zv_media_files')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', fileId)
    .where('deleted_at', 'is', null);
  if (tenantId) q = q.where('tenant_id', '=', tenantId);
  // Gate on the RETURNED ROW, never on `numUpdatedRows`. The Bun SQL dialect
  // reports it as 0n even when the write succeeded, so this threw "not found"
  // on every successful delete — the file WAS trashed and the caller was told
  // it failed. routes/webhooks.ts already documents the same trap.
  const deleted = await q.returning('id').executeTakeFirst();

  if (!deleted) {
    throw new Error('File not found or already deleted');
  }
}

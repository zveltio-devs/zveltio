import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

/**
 * Soft-deletes a media file by setting deleted_at.
 * Throws if the file is not found or already deleted.
 *
 * `tenantId` scopes the update so a caller can't trash another tenant's file by
 * id — a belt over the tenant policy (migration 023), which binds only inside a
 * tenant transaction and not at all for a role that bypasses RLS. Required: it
 * was optional, the extension passthrough called the three-argument form, and
 * where the policy did not bind that trashed another tenant's file. Extensions
 * reach this through `ctx.internals.moveToTrash`, which supplies the running
 * tenant itself.
 */
export async function moveToTrash(
  db: Database,
  fileId: string,
  deletedBy: string,
  tenantId: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const q = (db as any)
    .updateTable('zv_media_files')
    // `deleted_by` was never written, so the trash showed no one as having
    // deleted a file trashed through here. Resolved against "user" so a caller
    // that is not a user row (an API key's id) records NULL instead of failing
    // the foreign key.
    .set({
      deleted_at: new Date().toISOString(),
      deleted_by: sql`(SELECT id FROM "user" WHERE id = ${deletedBy})`,
    })
    .where('id', '=', fileId)
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null);
  // Gate on the RETURNED ROW, never on `numUpdatedRows`. The Bun SQL dialect
  // reports it as 0n even when the write succeeded, so this threw "not found"
  // on every successful delete — the file WAS trashed and the caller was told
  // it failed. routes/webhooks.ts already documents the same trap.
  const deleted = await q.returning('id').executeTakeFirst();

  if (!deleted) {
    throw new Error('File not found or already deleted');
  }
}

import type { Database } from '../../db/index.js';

/**
 * Soft-deletes a media file by setting deleted_at.
 * Throws if the file is not found or already deleted.
 */
export async function moveToTrash(
  db: Database,
  fileId: string,
  _deletedBy: string,
): Promise<void> {
  const result = await (db as any)
    .updateTable('zv_media_files')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', fileId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!result || result.numUpdatedRows === BigInt(0)) {
    throw new Error('File not found or already deleted');
  }
}

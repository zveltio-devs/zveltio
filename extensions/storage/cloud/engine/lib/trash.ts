import { sql } from 'kysely';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from '../../db/index.js';

const TRASH_RETENTION_DAYS = 30;

/**
 * Soft delete: moves a file to trash.
 */
export async function moveToTrash(
  db: Database,
  fileId: string,
  userId: string,
): Promise<void> {
  const file = await (db as any)
    .selectFrom('zv_media_files')
    .select(['id', 'folder_id'])
    .where('id', '=', fileId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!file) throw new Error('File not found');

  await (db as any).updateTable('zv_media_files').set({
    deleted_at: new Date(),
    deleted_by: userId,
    restore_folder_id: file.folder_id,
    folder_id: null,
  }).where('id', '=', fileId).execute();
}

/**
 * Restores a file from trash.
 */
export async function restoreFromTrash(
  db: Database,
  fileId: string,
): Promise<void> {
  const file = await (db as any)
    .selectFrom('zv_media_files')
    .select(['id', 'restore_folder_id'])
    .where('id', '=', fileId)
    .where('deleted_at', 'is not', null)
    .executeTakeFirst();

  if (!file) throw new Error('File not found in trash');

  let restoreFolderId = file.restore_folder_id;
  if (restoreFolderId) {
    const folderExists = await (db as any)
      .selectFrom('zv_media_folders')
      .select('id')
      .where('id', '=', restoreFolderId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!folderExists) restoreFolderId = null;
  }

  await (db as any).updateTable('zv_media_files').set({
    deleted_at: null,
    deleted_by: null,
    folder_id: restoreFolderId,
    restore_folder_id: null,
  }).where('id', '=', fileId).execute();
}

/**
 * Lists files in the trash for a user.
 */
export async function listTrash(db: Database, userId?: string) {
  const userFilter = userId ? sql`AND f.deleted_by = ${userId}` : sql``;
  return sql`
    SELECT f.*, u.name AS deleted_by_name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - f.deleted_at)) / 86400) AS days_in_trash,
      ${TRASH_RETENTION_DAYS} - ROUND(EXTRACT(EPOCH FROM (NOW() - f.deleted_at)) / 86400) AS days_remaining
    FROM zv_media_files f
    LEFT JOIN "user" u ON u.id = f.deleted_by
    WHERE f.deleted_at IS NOT NULL
    ${userFilter}
    ORDER BY f.deleted_at DESC
  `.execute(db).then(r => r.rows);
}

/**
 * Permanently deletes expired files from trash.
 * Called by a daily cron job.
 */
export async function purgeExpiredTrash(
  db: Database,
  s3: S3Client,
): Promise<number> {
  const expired = await sql<{ id: string; storage_path: string; thumbnail_url: string | null }>`
    SELECT id, storage_path, thumbnail_url FROM zv_media_files
    WHERE deleted_at IS NOT NULL
    AND deleted_at < NOW() - INTERVAL '${sql.raw(String(TRASH_RETENTION_DAYS))} days'
  `.execute(db);

  let purged = 0;
  const bucket = process.env.S3_BUCKET || 'zveltio';

  for (const file of expired.rows) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.storage_path })).catch(() => {});
    if (file.thumbnail_url) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `thumbnails/${file.id}.webp` })).catch(() => {});
    }

    const versions = await sql<{ storage_path: string }>`
      SELECT storage_path FROM zv_media_versions WHERE file_id = ${file.id}
    `.execute(db);
    for (const v of versions.rows) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.storage_path })).catch(() => {});
    }

    await sql`DELETE FROM zv_media_files WHERE id = ${file.id}`.execute(db);
    purged++;
  }

  if (purged > 0) console.log(`Zveltio Cloud: Purged ${purged} expired files from trash`);
  return purged;
}

import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from '../../db/index.js';

const MAX_VERSIONS = 20;

/**
 * Creates a new version of an existing file.
 * Current version becomes a previous version, new upload becomes current.
 */
export async function createFileVersion(
  db: Database,
  s3: S3Client,
  fileId: string,
  newBuffer: Buffer,
  newMimeType: string,
  newSize: number,
  uploadedBy: string,
): Promise<{ versionNum: number }> {
  const currentFile = await (db as any)
    .selectFrom('zv_media_files')
    .selectAll()
    .where('id', '=', fileId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!currentFile) throw new Error('File not found');

  const lastVersion = await sql<{ max_ver: number }>`
    SELECT COALESCE(MAX(version_num), 0) AS max_ver
    FROM zv_media_versions WHERE file_id = ${fileId}
  `.execute(db);
  const nextVer = (lastVersion.rows[0]?.max_ver ?? 0) + 1;

  // First version = snapshot of the original file
  if (nextVer === 1) {
    await (db as any).insertInto('zv_media_versions').values({
      id: nanoid(21),
      file_id: fileId,
      version_num: 1,
      storage_path: currentFile.storage_path,
      size_bytes: currentFile.size_bytes,
      mime_type: currentFile.mime_type,
      uploaded_by: currentFile.uploaded_by,
      created_at: currentFile.created_at,
    }).execute();
  }

  // Upload new file to S3 with unique version key
  const versionKey = `media/versions/${fileId}/v${nextVer + 1}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET || 'zveltio',
    Key: versionKey,
    Body: newBuffer,
    ContentType: newMimeType,
  }));

  await (db as any).insertInto('zv_media_versions').values({
    id: nanoid(21),
    file_id: fileId,
    version_num: nextVer + 1,
    storage_path: versionKey,
    size_bytes: newSize,
    mime_type: newMimeType,
    uploaded_by: uploadedBy,
  }).execute();

  // Update main file record with new content
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET || 'zveltio',
    Key: currentFile.storage_path,
    Body: newBuffer,
    ContentType: newMimeType,
  }));

  await (db as any).updateTable('zv_media_files').set({
    size_bytes: newSize,
    mime_type: newMimeType,
    updated_at: new Date(),
  }).where('id', '=', fileId).execute();

  // Cleanup: delete old versions beyond MAX_VERSIONS
  const oldVersions = await sql<{ id: string; storage_path: string }>`
    SELECT id, storage_path FROM zv_media_versions
    WHERE file_id = ${fileId}
    ORDER BY version_num DESC
    OFFSET ${MAX_VERSIONS}
  `.execute(db);

  for (const old of oldVersions.rows) {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET || 'zveltio',
      Key: old.storage_path,
    })).catch(() => {});
    await sql`DELETE FROM zv_media_versions WHERE id = ${old.id}`.execute(db);
  }

  return { versionNum: nextVer + 1 };
}

/**
 * Lists versions of a file.
 */
export async function listFileVersions(db: Database, fileId: string) {
  return sql`
    SELECT v.*, u.name AS uploaded_by_name
    FROM zv_media_versions v
    LEFT JOIN "user" u ON u.id = v.uploaded_by
    WHERE v.file_id = ${fileId}
    ORDER BY v.version_num DESC
  `.execute(db).then(r => r.rows);
}

/**
 * Restores a previous version as the current version.
 */
export async function restoreFileVersion(
  db: Database,
  s3: S3Client,
  fileId: string,
  versionNum: number,
  userId: string,
): Promise<void> {
  const version = await (db as any)
    .selectFrom('zv_media_versions')
    .selectAll()
    .where('file_id', '=', fileId)
    .where('version_num', '=', versionNum)
    .executeTakeFirst();

  if (!version) throw new Error('Version not found');

  const sourceObj = await s3.send(new GetObjectCommand({
    Bucket: process.env.S3_BUCKET || 'zveltio',
    Key: version.storage_path,
  }));

  const file = await (db as any)
    .selectFrom('zv_media_files')
    .selectAll()
    .where('id', '=', fileId)
    .executeTakeFirst();

  if (!file) throw new Error('File not found');

  const bodyBytes = await sourceObj.Body?.transformToByteArray();
  if (bodyBytes) {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || 'zveltio',
      Key: file.storage_path,
      Body: bodyBytes,
      ContentType: version.mime_type,
    }));
  }

  await (db as any).updateTable('zv_media_files').set({
    size_bytes: version.size_bytes,
    mime_type: version.mime_type,
    updated_at: new Date(),
  }).where('id', '=', fileId).execute();
}

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { createFileVersion, listFileVersions, restoreFileVersion } from './lib/file-versions.js';
import { moveToTrash, restoreFromTrash, listTrash, purgeExpiredTrash } from './lib/trash.js';
import { createShareLink, validateShareToken, incrementDownloadCount, listUserShares, revokeShare } from './lib/sharing.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function cloudRoutes(db: Database, auth: any, s3: S3Client): Hono {
  const app = new Hono();

  // Auth middleware — all cloud routes require auth except /share/:token
  const requireAuth = async (c: any, next: any) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  };

  // =============================================
  // FILE VERSIONS
  // =============================================

  app.post('/files/:id/versions', requireAuth, async (c) => {
    const fileId = c.req.param('id');
    const user = c.get('user') as any;
    const formData = await c.req.formData();
    const file = formData.get('file') as File;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await createFileVersion(db, s3, fileId, buffer, file.type, file.size, user.id);
      return c.json({ version: result.versionNum, message: 'New version uploaded' }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/files/:id/versions', requireAuth, async (c) => {
    const versions = await listFileVersions(db, c.req.param('id'));
    return c.json({ versions });
  });

  app.post('/files/:id/versions/:num/restore', requireAuth, async (c) => {
    const user = c.get('user') as any;
    try {
      await restoreFileVersion(db, s3, c.req.param('id'), parseInt(c.req.param('num')), user.id);
      return c.json({ success: true, message: 'Version restored' });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // =============================================
  // TRASH BIN
  // =============================================

  app.post('/files/:id/trash', requireAuth, async (c) => {
    const user = c.get('user') as any;
    try {
      await moveToTrash(db, c.req.param('id'), user.id);
      return c.json({ success: true, message: 'Moved to trash' });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/files/:id/restore', requireAuth, async (c) => {
    try {
      await restoreFromTrash(db, c.req.param('id'));
      return c.json({ success: true, message: 'Restored from trash' });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/trash', requireAuth, async (c) => {
    const user = c.get('user') as any;
    const items = await listTrash(db, user.id);
    return c.json({ items });
  });

  app.delete('/trash/purge', requireAuth, async (c) => {
    const purged = await purgeExpiredTrash(db, s3);
    return c.json({ purged, message: `${purged} files permanently deleted` });
  });

  // =============================================
  // SHARING
  // =============================================

  app.post('/share', requireAuth, zValidator('json', z.object({
    file_id: z.string().optional(),
    folder_id: z.string().optional(),
    share_type: z.enum(['view', 'download', 'edit']).default('download'),
    password: z.string().min(4).optional(),
    expires_in_hours: z.number().min(1).max(8760).optional(),
    max_downloads: z.number().min(1).optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    try {
      const result = await createShareLink(db, {
        fileId: data.file_id,
        folderId: data.folder_id,
        shareType: data.share_type,
        password: data.password,
        expiresAt: data.expires_in_hours ? new Date(Date.now() + data.expires_in_hours * 3600000) : undefined,
        maxDownloads: data.max_downloads,
        createdBy: user.id,
      });
      return c.json(result, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/shares', requireAuth, async (c) => {
    const user = c.get('user') as any;
    const shares = await listUserShares(db, user.id);
    return c.json({ shares });
  });

  app.delete('/shares/:id', requireAuth, async (c) => {
    const user = c.get('user') as any;
    await revokeShare(db, c.req.param('id'), user.id);
    return c.json({ success: true });
  });

  // =============================================
  // PUBLIC SHARE ACCESS (no auth required)
  // =============================================

  app.get('/share/:token', async (c) => {
    const password = c.req.query('password');
    const result = await validateShareToken(db, c.req.param('token'), password || undefined);

    if (!result.valid) {
      return c.json({ error: result.error }, result.error === 'Password required' ? 401 : 403);
    }

    if (result.file && result.share.share_type === 'download') {
      const presigned = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: process.env.S3_BUCKET || 'zveltio',
        Key: result.file.storage_path,
        ResponseContentDisposition: `attachment; filename="${result.file.original_filename}"`,
      }), { expiresIn: 3600 });

      await incrementDownloadCount(db, result.share.id);
      return c.redirect(presigned);
    }

    return c.json({
      file: result.file ? {
        name: result.file.original_filename,
        mime_type: result.file.mime_type,
        size_bytes: result.file.size_bytes,
        thumbnail_url: result.file.thumbnail_url,
      } : null,
      folder: result.folder ? {
        name: result.folder.name,
      } : null,
      share_type: result.share.share_type,
    });
  });

  // =============================================
  // FAVORITES
  // =============================================

  app.post('/favorites/:fileId', requireAuth, async (c) => {
    const user = c.get('user') as any;
    const fileId = c.req.param('fileId');

    const existing = await (db as any)
      .selectFrom('zv_media_favorites')
      .select('user_id')
      .where('user_id', '=', user.id)
      .where('file_id', '=', fileId)
      .executeTakeFirst();

    if (existing) {
      await (db as any).deleteFrom('zv_media_favorites')
        .where('user_id', '=', user.id)
        .where('file_id', '=', fileId)
        .execute();
      return c.json({ favorited: false });
    }

    await (db as any).insertInto('zv_media_favorites')
      .values({ user_id: user.id, file_id: fileId, created_at: new Date() })
      .execute();
    return c.json({ favorited: true });
  });

  app.get('/favorites', requireAuth, async (c) => {
    const user = c.get('user') as any;
    const files = await sql`
      SELECT f.*, fav.created_at AS favorited_at
      FROM zv_media_favorites fav
      INNER JOIN zv_media_files f ON f.id = fav.file_id
      WHERE fav.user_id = ${user.id} AND f.deleted_at IS NULL
      ORDER BY fav.created_at DESC
    `.execute(db);
    return c.json({ files: files.rows });
  });

  // =============================================
  // STORAGE QUOTA
  // =============================================

  app.get('/quota', requireAuth, async (c) => {
    const user = c.get('user') as any;

    const usage = await sql<{ total: string }>`
      SELECT COALESCE(SUM(size_bytes), 0) AS total
      FROM zv_media_files
      WHERE uploaded_by = ${user.id} AND deleted_at IS NULL
    `.execute(db);

    const quota = await (db as any)
      .selectFrom('zv_storage_quotas')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    const usedBytes = parseInt(usage.rows[0]?.total || '0');
    const quotaBytes = quota?.quota_bytes ?? 5368709120; // 5GB default

    return c.json({
      used_bytes: usedBytes,
      quota_bytes: quotaBytes,
      used_percent: Math.round((usedBytes / quotaBytes) * 100),
      remaining_bytes: Math.max(0, quotaBytes - usedBytes),
    });
  });

  return app;
}

/**
 * Public-only router for share link access — no auth required.
 * Mounted at /share so links are clean: https://app.com/share/<token>
 */
export function publicShareRouter(db: Database, s3: S3Client): Hono {
  const app = new Hono();

  app.get('/:token', async (c) => {
    const password = c.req.query('password');
    const result = await validateShareToken(db, c.req.param('token'), password || undefined);

    if (!result.valid) {
      return c.json({ error: result.error }, result.error === 'Password required' ? 401 : 403);
    }

    if (result.file && result.share.share_type === 'download') {
      const presigned = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: process.env.S3_BUCKET || 'zveltio',
        Key: result.file.storage_path,
        ResponseContentDisposition: `attachment; filename="${result.file.original_filename}"`,
      }), { expiresIn: 3600 });

      await incrementDownloadCount(db, result.share.id);
      return c.redirect(presigned);
    }

    return c.json({
      file: result.file ? {
        name: result.file.original_filename,
        mime_type: result.file.mime_type,
        size_bytes: result.file.size_bytes,
        thumbnail_url: result.file.thumbnail_url,
      } : null,
      folder: result.folder ? {
        name: result.folder.name,
      } : null,
      share_type: result.share.share_type,
    });
  });

  return app;
}

/**
 * Creates an S3 client from environment variables.
 * Exported so routes/index.ts can pass the same instance to cloudRoutes.
 */
export function createCloudS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || '',
      secretAccessKey: process.env.S3_SECRET_KEY || '',
    },
    forcePathStyle: true,
  });
}

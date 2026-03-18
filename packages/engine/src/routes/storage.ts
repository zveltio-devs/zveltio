import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { writeRateLimit } from '../middleware/rate-limit.js';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3: S3Client | null = null;

// H6 FIX: Extract image width/height from raw bytes — no external dependency needed.
// Supports PNG (IHDR chunk), JPEG (SOF markers), GIF89a/GIF87a, and WebP (VP8/VP8L/VP8X).
function extractImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width?: number; height?: number } {
  try {
    if (mimeType === 'image/png') {
      // PNG: IHDR chunk at bytes 8-28; width at 16-19 (BE), height at 20-23 (BE).
      if (buffer.length >= 24) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // JPEG: scan for SOF0-SOF3 markers (0xFF 0xC0..0xC3), skipping other segments.
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        const segLen = buffer.readUInt16BE(i + 2);
        if (segLen < 2) break; // malformed
        i += 2 + segLen;
      }
    } else if (mimeType === 'image/gif') {
      // GIF: logical screen descriptor at bytes 6-9 (LE).
      if (buffer.length >= 10) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      }
    } else if (mimeType === 'image/webp') {
      // WebP: RIFF header, then WEBP FourCC, then VP8/VP8L/VP8X chunk.
      if (
        buffer.length >= 30 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        const chunkType = buffer.toString('ascii', 12, 16);
        if (chunkType === 'VP8 ' && buffer.length >= 30) {
          // Lossy VP8: 14-bit width/height at bytes 26-29 (LE, minus 1 each).
          return {
            width: (buffer.readUInt16LE(26) & 0x3fff) + 1,
            height: (buffer.readUInt16LE(28) & 0x3fff) + 1,
          };
        } else if (chunkType === 'VP8L' && buffer.length >= 26 && buffer[20] === 0x2f) {
          // Lossless VP8L: packed 28-bit fields (14 bits each) starting at byte 21.
          const bits = buffer.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        } else if (chunkType === 'VP8X' && buffer.length >= 30) {
          // Extended VP8X: 24-bit LE width-1 at bytes 24-26, height-1 at 27-29.
          const w = buffer.readUIntLE(24, 3) + 1;
          const h = buffer.readUIntLE(27, 3) + 1;
          return { width: w, height: h };
        }
      }
    }
  } catch {
    /* parsing error — skip, leave dimensions undefined */
  }
  return {};
}

function getS3(): S3Client | null {
  if (!process.env.S3_ENDPOINT) return null;
  if (!s3) {
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true, // Required for SeaweedFS / MinIO
    });
  }
  return s3;
}

export function storageRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // GET / — List files
  app.get('/', async (c) => {
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { folder_id, limit = '50', page = '1' } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = (effectiveDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (folder_id) query = query.where('folder_id', '=', folder_id);
    else query = query.where('folder_id', 'is', null);

    const files = await query.offset(offset).limit(parsedLimit).execute();
    return c.json({ files });
  });

  // POST /upload — Upload a file
  // F1 FIX: Rate-limit uploads to 60/min per user (same as writeRateLimit) to prevent
  // disk/storage quota exhaustion from rapid automated uploads.
  app.post('/upload', writeRateLimit, async (c) => {
    const user = c.get('user') as any;
    const client = getS3();
    const bucket = process.env.S3_BUCKET || 'zveltio';

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Enforce upload size limit (default 50 MB, configurable via MAX_UPLOAD_BYTES env var)
    const maxBytes = parseInt(process.env.MAX_UPLOAD_BYTES ?? '') || 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      return c.json(
        { error: `File too large. Maximum allowed size is ${Math.round(maxBytes / 1024 / 1024)} MB.` },
        413,
      );
    }

    const folderId = formData.get('folder_id') as string | null;
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Unique storage path
    const ext = file.name.split('.').pop();
    const filename = `${crypto.randomUUID()}.${ext}`;
    const storagePath = `uploads/${new Date().getFullYear()}/${filename}`;

    let url: string | undefined;

    if (client) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storagePath,
          Body: buffer,
          ContentType: file.type,
          ContentLength: buffer.length,
        }),
      );
      url = `${process.env.S3_PUBLIC_URL || process.env.S3_ENDPOINT}/${bucket}/${storagePath}`;
    }

    // H6 FIX: Extract actual pixel dimensions for image formats.
    let width: number | undefined;
    let height: number | undefined;
    if (file.type.startsWith('image/')) {
      const dims = extractImageDimensions(buffer, file.type);
      width = dims.width;
      height = dims.height;
    }

    const uploadDb = (c.get('tenantTrx') as Database | null) ?? db;
    const record = await (uploadDb as any)
      .insertInto('zv_media_files')
      .values({
        folder_id: folderId || null,
        filename,
        original_name: file.name,
        mimetype: file.type,
        size: file.size,
        storage_path: storagePath,
        url,
        width,
        height,
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirst();

    return c.json({ file: record }, 201);
  });

  // GET /:id — Get file metadata
  app.get('/:id', async (c) => {
    const metaDb = (c.get('tenantTrx') as Database | null) ?? db;
    const file = await (metaDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);
    return c.json({ file });
  });

  // GET /:id/signed-url — Get a temporary signed URL
  app.get('/:id/signed-url', async (c) => {
    const client = getS3();
    if (!client) return c.json({ error: 'Storage not configured' }, 503);
    const signedDb = (c.get('tenantTrx') as Database | null) ?? db;

    const file = await (signedDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET || 'zveltio',
        Key: (file as any).storage_path,
      }),
      { expiresIn: 3600 },
    );

    return c.json({ url, expires_in: 3600 });
  });

  // DELETE /:id — Delete file (owner or admin only)
  app.delete('/:id', async (c) => {
    const user = c.get('user') as any;
    const deleteDb = (c.get('tenantTrx') as Database | null) ?? db;
    const client = getS3();
    const file = await (deleteDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    // I5: use checkPermission() instead of user.role — Better-Auth may not populate role on session
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if ((file as any).created_by !== user.id && !isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (client) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET || 'zveltio',
          Key: (file as any).storage_path,
        }),
      ).catch(() => { /* non-fatal if file missing from storage */ });
    }

    await (deleteDb as any).deleteFrom('zv_media_files').where('id', '=', (file as any).id).execute();
    return c.json({ success: true });
  });

  // GET /folders — List folders
  app.get('/folders', async (c) => {
    const foldersDb = (c.get('tenantTrx') as Database | null) ?? db;
    const folders = await (foldersDb as any)
      .selectFrom('zv_media_folders')
      .selectAll()
      .orderBy('name')
      .execute();
    return c.json({ folders });
  });

  // POST /folders — Create folder
  app.post('/folders', async (c) => {
    const user = c.get('user') as any;
    const foldersWriteDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { name, parent_id } = await c.req.json();

    if (!name) return c.json({ error: 'Folder name required' }, 400);

    const folder = await (foldersWriteDb as any)
      .insertInto('zv_media_folders')
      .values({ name, parent_id: parent_id || null, created_by: user.id })
      .returningAll()
      .executeTakeFirst();

    return c.json({ folder }, 201);
  });

  return app;
}

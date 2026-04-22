import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { writeRateLimit } from '../middleware/rate-limit.js';
import { AwsClient } from 'aws4fetch';

// Lazy aws4fetch client — replaces @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner.
// aws4fetch is a ~3KB fetch-based signer vs ~50MB for AWS SDK v3.
let _aws: AwsClient | null = null;

function getAws(): AwsClient | null {
  if (!process.env.S3_ENDPOINT) return null;
  if (!_aws) {
    _aws = new AwsClient({
      accessKeyId: process.env.S3_ACCESS_KEY || '',
      secretAccessKey: process.env.S3_SECRET_KEY || '',
      region: process.env.S3_REGION || 'us-east-1',
      service: 's3',
    });
  }
  return _aws;
}

function s3Url(key: string): string {
  const endpoint = process.env.S3_ENDPOINT!.replace(/\/$/, '');
  const bucket = process.env.S3_BUCKET || 'zveltio';
  return `${endpoint}/${bucket}/${key}`;
}

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
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // JPEG: scan for SOF0-SOF3 markers (0xFF 0xC0..0xC3), skipping other segments.
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        }
        const segLen = buffer.readUInt16BE(i + 2);
        if (segLen < 2) break; // malformed
        i += 2 + segLen;
      }
    } else if (mimeType === 'image/gif') {
      // GIF: logical screen descriptor at bytes 6-9 (LE).
      if (buffer.length >= 10) {
        return {
          width: buffer.readUInt16LE(6),
          height: buffer.readUInt16LE(8),
        };
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
        } else if (
          chunkType === 'VP8L' &&
          buffer.length >= 26 &&
          buffer[20] === 0x2f
        ) {
          // Lossless VP8L: packed 28-bit fields (14 bits each) starting at byte 21.
          const bits = buffer.readUInt32LE(21);
          return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >> 14) & 0x3fff) + 1,
          };
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
    const client = getAws();

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Enforce upload size limit (default 50 MB, configurable via MAX_UPLOAD_BYTES env var)
    const maxBytes =
      parseInt(process.env.MAX_UPLOAD_BYTES ?? '') || 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      return c.json(
        {
          error: `File too large. Maximum allowed size is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        },
        413,
      );
    }

    const folderId = formData.get('folder_id') as string | null;
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Validate extension against allowlist
    const ALLOWED_EXTENSIONS = new Set([
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'avif',
      'svg',
      'pdf',
      'txt',
      'md',
      'csv',
      'xlsx',
      'xls',
      'docx',
      'doc',
      'pptx',
      'ppt',
      'mp4',
      'webm',
      'mov',
      'avi',
      'mp3',
      'wav',
      'ogg',
      'flac',
      'zip',
      'tar',
      'gz',
      '7z',
      'json',
      'xml',
    ]);

    const rawExt = (file.name.split('.').pop() ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (!rawExt || !ALLOWED_EXTENSIONS.has(rawExt)) {
      return c.json(
        {
          error: `File type ".${rawExt}" is not allowed. Allowed types: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
        },
        400,
      );
    }

    const filename = `${crypto.randomUUID()}.${rawExt}`;
    const storagePath = `uploads/${new Date().getFullYear()}/${filename}`;

    let url: string | undefined;

    if (client) {
      const res = await client.fetch(s3Url(storagePath), {
        method: 'PUT',
        body: buffer,
        headers: {
          'Content-Type': file.type,
          'Content-Length': String(buffer.length),
        },
      });
      if (!res.ok) {
        return c.json({ error: `Storage upload failed: ${res.status}` }, 502);
      }
      url = `${process.env.S3_PUBLIC_URL || process.env.S3_ENDPOINT}/${process.env.S3_BUCKET || 'zveltio'}/${storagePath}`;
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

  // GET /folders — List folders (must be before GET /:id to prevent route conflict)
  app.get('/folders', async (c) => {
    const foldersDb = (c.get('tenantTrx') as Database | null) ?? db;
    const folders = await (foldersDb as any)
      .selectFrom('zv_media_folders')
      .selectAll()
      .orderBy('name')
      .execute();
    return c.json({ folders });
  });

  // POST /folders — Create folder (must be before GET /:id to prevent route conflict)
  app.post('/folders', async (c) => {
    const user = c.get('user') as any;
    const foldersWriteDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { name, parent_id } = await c.req.json();

    if (!name) return c.json({ error: 'Folder name required' }, 400);

    try {
      const folder = await (foldersWriteDb as any)
        .insertInto('zv_media_folders')
        .values({ name, parent_id: parent_id || null, created_by: user.id })
        .returningAll()
        .executeTakeFirst();

      return c.json({ folder }, 201);
    } catch (err) {
      console.error('[Storage] POST /folders error:', err);
      return c.json(
        { error: 'Failed to create folder', detail: String(err) },
        503,
      );
    }
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
    const client = getAws();
    if (!client) return c.json({ error: 'Storage not configured' }, 503);
    const signedDb = (c.get('tenantTrx') as Database | null) ?? db;

    const file = await (signedDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    // Build presigned URL: aws4fetch puts the signature in query params via signQuery: true.
    const target = new URL(s3Url((file as any).storage_path));
    target.searchParams.set('X-Amz-Expires', '3600');
    const signed = await client.sign(target, {
      method: 'GET',
      aws: { signQuery: true },
    });

    return c.json({ url: signed.url, expires_in: 3600 });
  });

  // GET /:id/transform — On-the-fly image resize/convert using imagescript (no native deps)
  app.get('/:id/transform', async (c) => {
    const transformDb = (c.get('tenantTrx') as Database | null) ?? db;
    const file = await (transformDb as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    const mime: string = (file as any).mimetype || '';
    if (!mime.startsWith('image/')) return c.json({ error: 'Not an image' }, 400);

    const { w, h, format, quality, fit } = c.req.query();
    const targetW = w ? Math.min(parseInt(w), 4096) : undefined;
    const targetH = h ? Math.min(parseInt(h), 4096) : undefined;
    const targetFmt = (format || 'png').toLowerCase();
    const targetQuality = quality ? Math.min(parseInt(quality), 100) : 80;

    if (!targetW && !targetH && !format) {
      return c.json({ error: 'Provide at least one of: w, h, format' }, 400);
    }

    // Fetch source bytes
    let sourceBytes: Uint8Array;
    const client = getAws();
    if (client && (file as any).storage_path) {
      const res = await client.fetch(s3Url((file as any).storage_path), { method: 'GET' });
      if (!res.ok) return c.json({ error: 'Failed to fetch source file' }, 502);
      sourceBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      return c.json({ error: 'Storage not configured or file has no storage path' }, 503);
    }

    const { Image } = await import('imagescript');
    const img = await Image.decode(sourceBytes);

    if (targetW || targetH) {
      const srcW = img.width;
      const srcH = img.height;
      let dstW = targetW || srcW;
      let dstH = targetH || srcH;

      if (fit !== 'stretch') {
        // Maintain aspect ratio (cover/contain both keep ratio; default = contain)
        const ratioW = dstW / srcW;
        const ratioH = dstH / srcH;
        const ratio = (fit === 'cover') ? Math.max(ratioW, ratioH) : Math.min(ratioW, ratioH);
        dstW = Math.round(srcW * ratio);
        dstH = Math.round(srcH * ratio);
      }
      img.resize(dstW, dstH);
    }

    let outBytes: Uint8Array;
    let outMime: string;
    if (targetFmt === 'jpeg' || targetFmt === 'jpg') {
      outBytes = await img.encodeJPEG(targetQuality);
      outMime = 'image/jpeg';
    } else if (targetFmt === 'gif') {
      outBytes = await img.encodeGIF();
      outMime = 'image/gif';
    } else {
      outBytes = await img.encode();
      outMime = 'image/png';
    }

    return new Response(outBytes, {
      headers: {
        'Content-Type': outMime,
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': String(outBytes.byteLength),
      },
    });
  });

  // DELETE /:id — Delete file (owner or admin only)
  app.delete('/:id', async (c) => {
    const user = c.get('user') as any;
    const deleteDb = (c.get('tenantTrx') as Database | null) ?? db;
    const client = getAws();
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
      await client
        .fetch(s3Url((file as any).storage_path), { method: 'DELETE' })
        .catch(() => {
          /* non-fatal if file missing from storage */
        });
    }

    await (deleteDb as any)
      .deleteFrom('zv_media_files')
      .where('id', '=', (file as any).id)
      .execute();
    return c.json({ success: true });
  });

  return app;
}

import { type Context, Hono } from 'hono';
import { guardSessionOrKey } from '../lib/admin-guard.js';
import { type RequestUser, rowAuthorId, STORAGE_SCOPE } from '../lib/data/index.js';
import type { Database } from '../db/index.js';
import {
  applyFileVisibility,
  FILE_VISIBILITIES,
  type FileVisibility,
} from '../lib/media-visibility.js';
import { checkStorageQuota } from '../lib/storage-quota.js';
import { writeRateLimit } from '../middleware/rate-limit.js';
import { getStorage } from '../lib/storage/index.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import {
  type FileActor,
  fileActorOf,
  folderVisible,
  maxUploadBytes,
  readableFile,
  removeFile,
  servedAs,
  setFileVisibility,
  storeFile,
} from '../lib/stored-files.js';
import { paging } from '../lib/utils.js';

// The checks every stored file passes live in lib/stored-files.ts, which a
// job's `host.files` shares (ADR 0032).
export { sanitizeSvgString } from '../lib/stored-files.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function storageRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // `:id` params feed uuid columns. A non-uuid (e.g. a guessed path like
  // /api/storage/files) must 404 cleanly, not bubble a Postgres 22P02 cast
  // error as a 500. Checked per-handler — a `/:id` middleware would also
  // swallow the real /folders and /upload routes.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const badId = (c: any) => !UUID_RE.test(c.req.param('id'));
  // A session, or an API key holding `$storage` for what the method does: the
  // verb every engine route derives from it. A PATCH (who sees a file) is
  // `update`, not `delete`: sharing a file is not destroying it, and a key
  // trusted to clean up should not be one that can publish to the firm.
  app.use('*', async (c, next) => {
    const m = c.req.method;
    const action =
      m === 'GET' || m === 'HEAD'
        ? 'read'
        : m === 'DELETE'
          ? 'delete'
          : m === 'PATCH'
            ? 'update'
            : 'create';
    const user = await guardSessionOrKey(c, auth, db, STORAGE_SCOPE, action);
    if (user instanceof Response) return user;
    c.set('user', user);
    await next();
  });

  // The request's user, as `lib/stored-files.ts` takes them.
  const actorOf = (c: Context): Promise<FileActor> =>
    fileActorOf(c.get('user') as RequestUser, tenantId(c));

  // GET / — List files
  app.get('/', async (c) => {
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { folder_id, limit = '50', page = '1' } = c.req.query();
    const { limit: parsedLimit, offset } = paging(page, limit, 50, 200);

    // Only what this user may read in this tenant — see lib/media-visibility.ts.
    const actor = await actorOf(c);
    let query = applyFileVisibility(
      effectiveDb.selectFrom('zv_media_files').selectAll().orderBy('created_at', 'desc'),
      actor.principalId,
      actor.seesAll,
      tenantId(c),
    );

    if (folder_id) query = query.where('folder_id', '=', folder_id);
    else query = query.where('folder_id', 'is', null);

    const files = await query.offset(offset).limit(parsedLimit).execute();
    return c.json({ files });
  });

  // POST /upload — Upload a file
  // F1 FIX: Rate-limit uploads to 60/min per user (same as writeRateLimit) to prevent
  // disk/storage quota exhaustion from rapid automated uploads.
  app.post('/upload', writeRateLimit, async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Refused before its bytes are read; `storeFile` asks again of the bytes.
    const maxBytes = maxUploadBytes();
    if (file.size > maxBytes) {
      return c.json(
        {
          error: `File too large. Maximum allowed size is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        },
        413,
      );
    }

    // Files are private by default (served only via a signed, expiring URL). Pass
    // `public=true` to store under the public namespace and get a bare public URL
    // (e.g. a company logo shown on the site). Business documents stay private.
    const stored = await storeFile(reqDb(c, db), await actorOf(c), {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      folderId: formData.get('folder_id') as string | null,
      isPublic: formData.get('public') === 'true',
      typeHint: file.type,
    });
    if (!('file' in stored)) return c.json(stored.body, stored.status);
    return c.json({ file: stored.file }, 201);
  });

  // GET /folders — List folders (must be before GET /:id to prevent route conflict)
  app.get('/folders', async (c) => {
    const foldersDb = (c.get('tenantTrx') as Database | null) ?? db;
    const folders = await foldersDb
      .selectFrom('zv_media_folders')
      .selectAll()
      .where('tenant_id', '=', tenantId(c))
      .orderBy('name')
      .execute();
    return c.json({ folders });
  });

  // POST /folders — Create folder (must be before GET /:id to prevent route conflict)
  app.post('/folders', async (c) => {
    const user = c.get('user') as RequestUser;
    const foldersWriteDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { name, parent_id } = await c.req.json();

    if (!name) return c.json({ error: 'Folder name required' }, 400);
    if (parent_id && !(await folderVisible(foldersWriteDb, tenantId(c), parent_id))) {
      return c.json({ error: 'Folder not found' }, 404);
    }

    try {
      const folder = await foldersWriteDb
        .insertInto('zv_media_folders')
        .values({
          name,
          parent_id: parent_id || null,
          created_by: rowAuthorId(user),
          tenant_id: tenantId(c),
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ folder }, 201);
    } catch (err) {
      console.error('[Storage] POST /folders error:', err);
      return c.json({ error: 'Failed to create folder', detail: String(err) }, 503);
    }
  });

  // GET /quota — the caller's own usage and allowance (lib/storage-quota.ts), as
  // an upload counts them: a key's are its issuer's. Before GET /:id.
  app.get('/quota', async (c) => {
    const actor = await actorOf(c);
    const q = await checkStorageQuota(reqDb(c, db), actor.tenantId, actor.author, 0);
    return c.json({ used_bytes: q.usedBytes, quota_bytes: q.quotaBytes });
  });

  // GET /:id — Get file metadata
  app.get('/:id', async (c) => {
    if (badId(c)) return c.json({ error: 'File not found' }, 404);
    const file = await readableFile(reqDb(c, db), await actorOf(c), c.req.param('id'));
    if (!file) return c.json({ error: 'File not found' }, 404);
    return c.json({ file });
  });

  // GET /:id/signed-url — Get a temporary signed URL
  app.get('/:id/signed-url', async (c) => {
    if (badId(c)) return c.json({ error: 'File not found' }, 404);
    const storage = getStorage();
    if (!storage.isConfigured()) return c.json({ error: 'Storage not configured' }, 503);
    const file = await readableFile(reqDb(c, db), await actorOf(c), c.req.param('id'));
    if (!file) return c.json({ error: 'File not found' }, 404);

    // Time-limited URL: S3 → aws4fetch presigned GET; local → HMAC-signed
    // /files URL. Both honour the 1h expiry, and serve the file as `servedAs`.
    const signedUrl = await storage.signedUrl(
      file.storage_path,
      3600,
      servedAs(file.original_name, file.mimetype),
    );

    return c.json({ url: signedUrl, expires_in: 3600 });
  });

  // GET /:id/transform — On-the-fly image resize/convert using imagescript (no native deps)
  app.get('/:id/transform', async (c) => {
    if (badId(c)) return c.json({ error: 'File not found' }, 404);
    const file = await readableFile(reqDb(c, db), await actorOf(c), c.req.param('id'));
    if (!file) return c.json({ error: 'File not found' }, 404);

    const mime = file.mimetype || '';
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
    const storage = getStorage();
    if (storage.isConfigured() && file.storage_path) {
      const obj = await storage.get(file.storage_path).catch(() => null);
      if (!obj) return c.json({ error: 'Failed to fetch source file' }, 502);
      sourceBytes = obj.bytes;
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
        const ratio = fit === 'cover' ? Math.max(ratioW, ratioH) : Math.min(ratioW, ratioH);
        dstW = Math.round(srcW * ratio);
        dstH = Math.round(srcH * ratio);
      }
      img.resize(dstW, dstH);
    }

    let outBytes: Uint8Array;
    let outMime: string;
    if (targetFmt === 'jpeg' || targetFmt === 'jpg') {
      // imagescript JPEGQuality is 1-100 integer cast
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      outBytes = await img.encodeJPEG(targetQuality as any);
      outMime = 'image/jpeg';
    } else {
      // PNG for all other formats (imagescript doesn't support GIF encode)
      outBytes = await img.encode();
      outMime = 'image/png';
    }

    return new Response(outBytes as unknown as BodyInit, {
      headers: {
        'Content-Type': outMime,
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': String(outBytes.byteLength),
      },
    });
  });

  // PATCH /:id — change who sees a file, `{ visibility: 'personal' | 'tenant' }`:
  // whoever may delete it (`setFileVisibility`), with DELETE's 404 and 403.
  app.patch('/:id', async (c) => {
    if (badId(c)) return c.json({ error: 'File not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { visibility?: unknown } | null;
    const visibility = body?.visibility as FileVisibility;
    if (!FILE_VISIBILITIES.includes(visibility)) {
      return c.json({ error: `visibility must be one of: ${FILE_VISIBILITIES.join(', ')}` }, 400);
    }
    const changed = await setFileVisibility(
      reqDb(c, db),
      await actorOf(c),
      c.req.param('id'),
      visibility,
    );
    if (!('file' in changed)) return c.json(changed.body, changed.status);
    return c.json({ file: changed.file });
  });

  // DELETE /:id — Delete file (owner or admin only)
  app.delete('/:id', async (c) => {
    if (badId(c)) return c.json({ error: 'File not found' }, 404);
    const removed = await removeFile(reqDb(c, db), await actorOf(c), c.req.param('id'));
    if (!('ok' in removed)) return c.json(removed.body, removed.status);
    return c.json({ success: true });
  });

  return app;
}

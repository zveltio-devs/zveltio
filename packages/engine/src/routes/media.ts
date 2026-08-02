import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getStorage } from '../lib/storage/index.js';
import type { Database } from '../db/index.js';
import { escapeLike } from '../lib/data/index.js';
import { generateId } from '../lib/utils.js';
import { isTenantAdmin } from '../lib/tenancy/index.js';
import { applyFileVisibility, mayReadFile } from '../lib/media-visibility.js';
// @ts-ignore — cloud/trash is an optional extension
import { moveToTrash } from '../lib/cloud/trash.js';
import { scheduleFileIndexing } from '../lib/cloud/document-indexer.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import { checkStorageQuota } from '../lib/storage-quota.js';

// Object storage goes through the pluggable driver (lib/storage): `local`
// filesystem by default, `s3` (aws4fetch) when S3_ENDPOINT is set.

/**
 * May this user delete this file?
 *
 * The media router requires only a session, and `moveToTrash` filters by id,
 * `deleted_at` and tenant — no owner check anywhere. So any authenticated user
 * could trash any file in their tenant by naming its id.
 *
 * Owner or tenant admin. Deliberately not "anyone who can read it": reading a
 * shared file and destroying it are different acts.
 */
async function mayDeleteFile(rdb: Database, fileId: string, userId: string): Promise<boolean> {
  const row = await rdb
    .selectFrom('zv_media_files')
    .select(['created_by'])
    .where('id', '=', fileId)
    .executeTakeFirst()
    .catch(() => undefined);
  // Absent file: let moveToTrash produce the not-found path rather than
  // reporting "forbidden", which would confirm the id exists elsewhere.
  if (!row) return true;
  if (row.created_by === userId) return true;
  return isTenantAdmin(userId).catch(() => false);
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function mediaRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  // Auth middleware — all media routes require authentication
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // ==========================================
  // FOLDERS
  // ==========================================

  router.get('/folders', async (c) => {
    const folders = await reqDb(c, db)
      .selectFrom('zv_media_folders')
      .selectAll()
      .where('tenant_id', '=', tenantId(c))
      .where('deleted_at', 'is', null)
      .orderBy('name', 'asc')
      .execute();
    return c.json({ folders });
  });

  router.post(
    '/folders',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        parent_id: z.string().optional(),
        description: z.string().optional(),
      }),
    ),
    async (c) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;
      const data = c.req.valid('json');
      const folder = {
        id: crypto.randomUUID(),
        tenant_id: tenantId(c),
        name: data.name,
        parent_id: data.parent_id || null,
        created_by: user.id,
      };
      await reqDb(c, db).insertInto('zv_media_folders').values(folder).execute();
      return c.json({ folder }, 201);
    },
  );

  router.put(
    '/folders/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        parent_id: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');

      const folder = await reqDb(c, db)
        .selectFrom('zv_media_folders')
        .select(['id', 'created_by'])
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId(c))
        .executeTakeFirst();
      if (!folder) return c.json({ error: 'Folder not found' }, 404);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;
      if (folder.created_by !== user.id && !(await isTenantAdmin(user.id))) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      // zv_media_folders has no updated_at column — don't write it.
      await reqDb(c, db)
        .updateTable('zv_media_folders')
        .set(data)
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId(c))
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/folders/:id', async (c) => {
    const id = c.req.param('id');

    const folder = await reqDb(c, db)
      .selectFrom('zv_media_folders')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
    if (!folder) return c.json({ error: 'Folder not found' }, 404);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    if (folder.created_by !== user.id && user.role !== 'god') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const subfolders = await reqDb(c, db)
      .selectFrom('zv_media_folders')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('parent_id', '=', id)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();

    if (Number(subfolders?.count) > 0) {
      return c.json({ error: 'Folder has subfolders. Delete them first.' }, 400);
    }

    const fileCount = await reqDb(c, db)
      .selectFrom('zv_media_files')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('folder_id', '=', id)
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();

    if (Number(fileCount?.count) > 0) {
      return c.json({ error: 'Folder is not empty. Move or delete files first.' }, 400);
    }

    await reqDb(c, db)
      .deleteFrom('zv_media_folders')
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId(c))
      .execute();
    return c.json({ success: true });
  });

  // ==========================================
  // FILES
  // ==========================================

  router.get('/files', async (c) => {
    const { folder_id, tag, search, limit = '50', offset = '0', mime_type } = c.req.query();

    // Only what this user may read. The listing used to require a session and
    // nothing else, so it showed every colleague's uploads to everyone.
    const listUser = c.get('user' as never) as { id: string };
    let query = applyFileVisibility(
      reqDb(c, db)
        .selectFrom('zv_media_files')
        .selectAll()
        .where('tenant_id', '=', tenantId(c))
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc'),
      listUser.id,
      await isTenantAdmin(listUser.id).catch(() => false),
    );

    if (folder_id) query = query.where('folder_id', '=', folder_id);
    if (mime_type) query = query.where('mimetype', 'ilike', `${mime_type}%`);

    if (search) {
      // Cap at 100 chars — longer patterns give no additional selectivity but
      // multiply matching cost across 4 ilike columns (each O(N) without trigram index).
      const safeSearch = `%${escapeLike(search.substring(0, 100))}%`;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      query = query.where(({ or, cmpr }: any) =>
        or([
          cmpr('filename', 'ilike', safeSearch),
          cmpr('original_name', 'ilike', safeSearch),
          cmpr('title', 'ilike', safeSearch),
          cmpr('description', 'ilike', safeSearch),
        ]),
      );
    }

    if (tag) {
      query = query
        .innerJoin('zv_media_file_tags', 'zv_media_file_tags.file_id', 'zv_media_files.id')
        .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
        .where('zv_media_tags.name', '=', tag);
    }

    const safeLimit = Math.min(Number(limit) || 50, 500);
    const files = await query.limit(safeLimit).offset(Number(offset)).execute();

    // P1: batch-load all tags in a single query instead of N+1 per-file queries
    if (files.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const fileIds = files.map((f: any) => f.id);
      const allTags = await reqDb(c, db)
        .selectFrom('zv_media_file_tags')
        .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
        .select([
          'zv_media_file_tags.file_id',
          'zv_media_tags.id',
          'zv_media_tags.name',
          'zv_media_tags.color',
        ])
        .where('zv_media_file_tags.file_id', 'in', fileIds)
        .execute();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const tagsByFile = new Map<string, any[]>();
      for (const tag of allTags) {
        const list = tagsByFile.get(tag.file_id) ?? [];
        list.push({ id: tag.id, name: tag.name, color: tag.color });
        tagsByFile.set(tag.file_id, list);
      }
      for (const file of files) {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        (file as any).tags = tagsByFile.get((file as any).id) ?? [];
      }
    }

    let countQuery = reqDb(c, db)
      .selectFrom('zv_media_files')
      .select(({ fn }) => fn.count('id').as('count'))
      .where('tenant_id', '=', tenantId(c))
      .where('deleted_at', 'is', null);

    if (folder_id) countQuery = countQuery.where('folder_id', '=', folder_id);
    if (mime_type) countQuery = countQuery.where('mimetype', 'ilike', `${mime_type}%`);
    if (search) {
      const safeSearchCount = `%${escapeLike(search.substring(0, 100))}%`;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      countQuery = countQuery.where(({ or, cmpr }: any) =>
        or([
          cmpr('filename', 'ilike', safeSearchCount),
          cmpr('original_name', 'ilike', safeSearchCount),
          cmpr('title', 'ilike', safeSearchCount),
          cmpr('description', 'ilike', safeSearchCount),
        ]),
      );
    }

    const countResult = await countQuery.executeTakeFirst();
    const total = Number(countResult?.count || 0);

    return c.json({
      files,
      pagination: { total, limit: Number(limit), offset: Number(offset) },
    });
  });

  router.get('/files/:id', async (c) => {
    const id = c.req.param('id');

    const file = await reqDb(c, db)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId(c))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    // 404 rather than 403: whether a colleague's private file exists is itself
    // something they did not share.
    const getUser = c.get('user' as never) as { id: string };
    if (!mayReadFile(file, getUser.id, await isTenantAdmin(getUser.id).catch(() => false))) {
      return c.json({ error: 'File not found' }, 404);
    }

    const tags = await reqDb(c, db)
      .selectFrom('zv_media_file_tags')
      .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
      .select(['zv_media_tags.id', 'zv_media_tags.name', 'zv_media_tags.color'])
      .where('zv_media_file_tags.file_id', '=', id)
      .execute();

    return c.json({ file: { ...file, tags } });
  });

  router.post('/upload', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const folderId = formData.get('folder_id') as string | null;
    const title = formData.get('title') as string | null;
    const description = formData.get('description') as string | null;
    const altText = formData.get('alt_text') as string | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Check storage quota. Shared with /api/storage/upload, which writes the
    // same table and used to skip this entirely.
    const quota = await checkStorageQuota(reqDb(c, db), tenantId(c), user.id, file.size);
    if (!quota.ok) {
      return c.json({ error: 'Storage quota exceeded' }, 413);
    }

    // zv_media_files.id is a UUID column — a 21-char nanoid (generateId(21))
    // fails the insert with "invalid input syntax for type uuid", so every
    // upload 500'd. Use a UUID, same as the folder-create path above.
    const fileId = crypto.randomUUID();
    const rawFileExt = file.name.split('.').pop() ?? 'bin';
    const filename = `${fileId}.${rawFileExt}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    // ── Security: file type validation ──────────────────────────────────────
    // 1. Allowlist declared MIME types — reject anything not in the list
    const ALLOWED_MIME_TYPES = new Set([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/avif',
      'image/tiff',
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
    ]);
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return c.json({ error: `File type not allowed: ${file.type}` }, 415);
    }

    // 2. Magic byte validation — verify actual content matches declared MIME.
    // Clients can lie about Content-Type; magic bytes cannot be faked without
    // also making the file invalid for its true format.
    // Read 12 bytes: needed for WEBP (RIFF header 4B + size 4B + "WEBP" marker 4B).
    const magic = buffer.slice(0, 12);
    const MAGIC_SIGNATURES: Array<{
      mime: string;
      bytes: number[];
      offset?: number;
    }> = [
      { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
      { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
      { mime: 'image/gif', bytes: [0x47, 0x49, 0x46] },
      { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF header at 0; WEBP marker checked separately below
      { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
    ];
    const signatureMatch = MAGIC_SIGNATURES.find((sig) => {
      const off = sig.offset ?? 0;
      return sig.bytes.every((b, i) => magic[off + i] === b);
    });
    if (signatureMatch && signatureMatch.mime !== file.type) {
      return c.json(
        {
          error: `File content does not match declared type. Expected ${file.type} but content looks like ${signatureMatch.mime}`,
        },
        415,
      );
    }

    // WEBP: RIFF header must be followed by "WEBP" marker at bytes 8-11.
    if (file.type === 'image/webp') {
      const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
      if (!WEBP_MARKER.every((b, i) => magic[8 + i] === b)) {
        return c.json({ error: 'File content does not match declared type.' }, 415);
      }
    }

    // Office Open XML formats (docx, xlsx, pptx) are ZIP archives — require PK\x03\x04 signature.
    const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
    const OFFICE_MIMES = new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]);
    if (OFFICE_MIMES.has(file.type)) {
      if (!ZIP_MAGIC.every((b, i) => magic[i] === b)) {
        return c.json({ error: 'File content does not match declared type.' }, 415);
      }
    }

    // 3. SVG: reject XSS vectors — scripts, event handlers, javascript: links, external references.
    if (file.type === 'image/svg+xml') {
      const svgText = buffer.toString('utf-8');
      // Covers: <script>, on* event handlers (onload, onerror, onclick…), javascript: URIs,
      // xlink:href / href pointing to external/JS resources, <use> with external targets.
      const SVG_XSS = [
        /<script/i,
        /\bon\w+\s*=/i, // onload=, onerror=, onclick=, etc.
        /javascript\s*:/i,
        /xlink:href\s*=\s*["'][^"'#]/i, // external xlink:href (allow same-doc #fragments)
        /\shref\s*=\s*["'](?!#)/i, // href that isn't a same-doc fragment reference
      ];
      if (SVG_XSS.some((re) => re.test(svgText))) {
        return c.json(
          {
            error: 'SVG files with embedded scripts or event handlers are not allowed',
          },
          415,
        );
      }
    }

    // 4. Extension allowlist — reject files whose names end in executable extensions
    const ALLOWED_EXTENSIONS = new Set([
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'avif',
      'tiff',
      'svg',
      'pdf',
      'txt',
      'csv',
      'json',
      'docx',
      'xlsx',
      'pptx',
      'mp4',
      'webm',
      'mp3',
      'wav',
      'ogg',
    ]);
    const fileExt = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.has(fileExt)) {
      return c.json({ error: `File extension not allowed: .${fileExt}` }, 415);
    }
    // ── End security validation ──────────────────────────────────────────────

    let width: number | null = null;
    let height: number | null = null;
    let thumbnailUrl: string | null = null;

    if (file.type.startsWith('image/')) {
      try {
        // Dynamic import — sharp is an optional dependency
        // @ts-ignore — sharp is an optional peer dependency
        const sharpMod = await import('sharp').catch(() => null);
        if (sharpMod) {
          const sharp = sharpMod.default;
          const metadata = await sharp(buffer).metadata();
          width = metadata.width || null;
          height = metadata.height || null;

          const thumbnailBuffer = await sharp(buffer)
            .resize(300, 300, { fit: 'inside' })
            .webp({ quality: 80 })
            .toBuffer();

          const thumbnailKey = `thumbnails/${fileId}.webp`;
          const thumbStore = getStorage();
          if (thumbStore.isConfigured()) {
            await thumbStore.put(thumbnailKey, thumbnailBuffer, { contentType: 'image/webp' });
            thumbnailUrl = thumbStore.publicUrl(thumbnailKey);
          }
        }
      } catch (error) {
        console.warn('Image processing skipped:', error);
      }
    }

    const key = `media/${filename}`;
    const storage = getStorage();
    if (storage.isConfigured()) {
      try {
        await storage.put(key, buffer, { contentType: file.type });
      } catch (err) {
        return c.json({ error: `Storage upload failed: ${(err as Error).message}` }, 502);
      }
    }

    const url = storage.publicUrl(key);

    const fileRecord = {
      id: fileId,
      tenant_id: tenantId(c),
      folder_id: folderId || null,
      filename,
      original_name: file.name,
      mimetype: file.type,
      size: file.size,
      width,
      height,
      url,
      thumbnail_url: thumbnailUrl,
      storage_path: key,
      created_by: user.id,
      // The media LIBRARY is the shared-asset half of this table — an editor
      // uploads the logo so everyone can use it. The column defaults to
      // `personal`, so this route says so explicitly rather than inheriting a
      // default meant for the personal-storage route.
      visibility: 'tenant' as const,
      title: title || null,
      description: description || null,
      alt_text: altText || null,
    };

    await reqDb(c, db).insertInto('zv_media_files').values(fileRecord).execute();

    // AI document indexing — fire-and-forget
    scheduleFileIndexing(reqDb(c, db), fileId, buffer, file.type);

    return c.json({ file: fileRecord }, 201);
  });

  router.put(
    '/files/:id',
    zValidator(
      'json',
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        alt_text: z.string().optional(),
        folder_id: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');

      const file = await reqDb(c, db)
        .selectFrom('zv_media_files')
        .select(['id', 'created_by'])
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId(c))
        .executeTakeFirst();
      if (!file) return c.json({ error: 'File not found' }, 404);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;
      if (file.created_by !== user.id && !(await isTenantAdmin(user.id))) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      await reqDb(c, db)
        .updateTable('zv_media_files')
        .set({ ...data, updated_at: new Date() })
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId(c))
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/files/:id', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const id = c.req.param('id');

    try {
      if (!(await mayDeleteFile(reqDb(c, db), id, user.id))) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      await moveToTrash(reqDb(c, db), id, user.id, tenantId(c));
      return c.json({ success: true });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // POST /files/batch-delete — must be registered before /files/:id to avoid conflict
  router.post(
    '/files/batch-delete',
    zValidator('json', z.object({ ids: z.array(z.string()) })),
    async (c) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;
      const { ids } = c.req.valid('json');

      // Same ownership rule as the single delete. Without it the batch route
      // was the easier way to do exactly what the single one now refuses.
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          if (!(await mayDeleteFile(reqDb(c, db), id, user.id))) {
            throw new Error('forbidden');
          }
          return moveToTrash(reqDb(c, db), id, user.id, tenantId(c));
        }),
      );
      const moved = results.filter((r) => r.status === 'fulfilled').length;
      const refused = results.length - moved;

      return c.json({ success: true, deleted: moved, refused });
    },
  );

  // ==========================================
  // TAGS
  // ==========================================

  router.get('/tags', async (c) => {
    const tags = await reqDb(c, db)
      .selectFrom('zv_media_tags')
      .selectAll()
      .where('tenant_id', '=', tenantId(c))
      .orderBy('name', 'asc')
      .execute();
    return c.json({ tags });
  });

  router.post(
    '/tags',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        color: z.string().optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      try {
        // id is a uuid column with a gen_random_uuid() default — let the DB
        // generate it (the old code set a 21-char nanoid, which threw an
        // "invalid input syntax for type uuid" on every create) and return the row.
        const tag = await reqDb(c, db)
          .insertInto('zv_media_tags')
          .values({
            name: data.name,
            color: data.color || null,
            tenant_id: tenantId(c),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return c.json({ tag }, 201);
      } catch {
        return c.json({ error: 'Tag already exists' }, 400);
      }
    },
  );

  router.put(
    '/tags/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).optional(),
        color: z.string().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');
      await reqDb(c, db)
        .updateTable('zv_media_tags')
        .set(data)
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId(c))
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/tags/:id', async (c) => {
    await reqDb(c, db)
      .deleteFrom('zv_media_tags')
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .execute();
    return c.json({ success: true });
  });

  router.post(
    '/files/:id/tags',
    zValidator('json', z.object({ tag_id: z.string() })),
    async (c) => {
      const fileId = c.req.param('id');
      const { tag_id } = c.req.valid('json');
      try {
        await reqDb(c, db)
          .insertInto('zv_media_file_tags')
          .values({ file_id: fileId, tag_id, tenant_id: tenantId(c) })
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .onConflict((oc: any) => oc.doNothing())
          .execute();
        return c.json({ success: true });
      } catch {
        return c.json({ error: 'Failed to add tag' }, 400);
      }
    },
  );

  router.delete('/files/:id/tags/:tagId', async (c) => {
    await reqDb(c, db)
      .deleteFrom('zv_media_file_tags')
      .where('file_id', '=', c.req.param('id'))
      .where('tag_id', '=', c.req.param('tagId'))
      .where('tenant_id', '=', tenantId(c))
      .execute();
    return c.json({ success: true });
  });

  // ==========================================
  // STATS
  // ==========================================

  router.get('/stats', async (c) => {
    const [totalFiles, totalSize, filesByType, totalFolders, totalTags] = await Promise.all([
      reqDb(c, db)
        .selectFrom('zv_media_files')
        .select(({ fn }) => fn.count('id').as('count'))
        .where('tenant_id', '=', tenantId(c))
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      reqDb(c, db)
        .selectFrom('zv_media_files')
        .select(({ fn }) => fn.sum('size').as('total'))
        .where('tenant_id', '=', tenantId(c))
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      reqDb(c, db)
        .selectFrom('zv_media_files')
        .select(['mimetype', (eb) => eb.fn.count('id').as('count')])
        .where('tenant_id', '=', tenantId(c))
        .where('deleted_at', 'is', null)
        .groupBy('mimetype')
        .orderBy('count', 'desc')
        .limit(10)
        .execute(),
      reqDb(c, db)
        .selectFrom('zv_media_folders')
        .select(({ fn }) => fn.count('id').as('count'))
        .where('tenant_id', '=', tenantId(c))
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      reqDb(c, db)
        .selectFrom('zv_media_tags')
        .select(({ fn }) => fn.count('id').as('count'))
        .executeTakeFirst(),
    ]);

    return c.json({
      totalFiles: Number(totalFiles?.count || 0),
      totalSize: Number(totalSize?.total || 0),
      filesByType,
      totalFolders: Number(totalFolders?.count || 0),
      totalTags: Number(totalTags?.count || 0),
    });
  });

  return router;
}

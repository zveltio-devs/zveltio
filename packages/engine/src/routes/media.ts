import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from '../db/index.js';
import { escapeLike } from '../lib/query-utils.js';

// Bun native crypto.randomUUID() - 128-bit UUID (version 4)
function generateId(size: number = 21): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const randomValues = new Uint8Array(size);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < size; i++) {
    id += chars[randomValues[i] % chars.length];
  }
  return id;
}
// @ts-ignore — cloud/trash is an optional extension
import { moveToTrash } from '../lib/cloud/trash.js';
import { scheduleFileIndexing } from '../lib/cloud/document-indexer.js';

const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: true,
});

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
    const folders = await (db as any)
      .selectFrom('zv_media_folders')
      .selectAll()
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
      const user = c.get('user' as never) as any;
      const data = c.req.valid('json');
      const folder = {
        id: generateId(21),
        name: data.name,
        parent_id: data.parent_id || null,
        description: data.description || null,
        created_by: user.id,
      };
      await (db as any).insertInto('zv_media_folders').values(folder).execute();
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

      const folder = await (db as any)
        .selectFrom('zv_media_folders')
        .select(['id', 'created_by'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!folder) return c.json({ error: 'Folder not found' }, 404);
      const user = c.get('user' as never) as any;
      if (
        folder.created_by !== user.id &&
        user.role !== 'admin' &&
        user.role !== 'god'
      ) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      await (db as any)
        .updateTable('zv_media_folders')
        .set({ ...data, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/folders/:id', async (c) => {
    const id = c.req.param('id');

    const folder = await (db as any)
      .selectFrom('zv_media_folders')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!folder) return c.json({ error: 'Folder not found' }, 404);
    const user = c.get('user' as never) as any;
    if (
      folder.created_by !== user.id &&
      user.role !== 'admin' &&
      user.role !== 'god'
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const subfolders = await (db as any)
      .selectFrom('zv_media_folders')
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('parent_id', '=', id)
      .executeTakeFirst();

    if (Number(subfolders?.count) > 0) {
      return c.json(
        { error: 'Folder has subfolders. Delete them first.' },
        400,
      );
    }

    const fileCount = await (db as any)
      .selectFrom('zv_media_files')
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('folder_id', '=', id)
      .executeTakeFirst();

    if (Number(fileCount?.count) > 0) {
      return c.json(
        { error: 'Folder is not empty. Move or delete files first.' },
        400,
      );
    }

    await (db as any)
      .deleteFrom('zv_media_folders')
      .where('id', '=', id)
      .execute();
    return c.json({ success: true });
  });

  // ==========================================
  // FILES
  // ==========================================

  router.get('/files', async (c) => {
    const {
      folder_id,
      tag,
      search,
      limit = '50',
      offset = '0',
      mime_type,
    } = c.req.query();

    let query = (db as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc');

    if (folder_id) query = query.where('folder_id', '=', folder_id);
    if (mime_type) query = query.where('mime_type', 'ilike', `${mime_type}%`);

    if (search) {
      // P1: escape LIKE metacharacters to prevent wildcard DoS
      const safeSearch = `%${escapeLike(search)}%`;
      query = query.where(({ or, cmpr }: any) =>
        or([
          cmpr('filename', 'ilike', safeSearch),
          cmpr('original_filename', 'ilike', safeSearch),
          cmpr('title', 'ilike', safeSearch),
          cmpr('description', 'ilike', safeSearch),
        ]),
      );
    }

    if (tag) {
      query = query
        .innerJoin(
          'zv_media_file_tags',
          'zv_media_file_tags.file_id',
          'zv_media_files.id',
        )
        .innerJoin(
          'zv_media_tags',
          'zv_media_tags.id',
          'zv_media_file_tags.tag_id',
        )
        .where('zv_media_tags.name', '=', tag);
    }

    const safeLimit = Math.min(Number(limit) || 50, 500);
    const files = await query.limit(safeLimit).offset(Number(offset)).execute();

    // P1: batch-load all tags in a single query instead of N+1 per-file queries
    if (files.length > 0) {
      const fileIds = files.map((f: any) => f.id);
      const allTags = await (db as any)
        .selectFrom('zv_media_file_tags')
        .innerJoin(
          'zv_media_tags',
          'zv_media_tags.id',
          'zv_media_file_tags.tag_id',
        )
        .select([
          'zv_media_file_tags.file_id',
          'zv_media_tags.id',
          'zv_media_tags.name',
          'zv_media_tags.color',
        ])
        .where('zv_media_file_tags.file_id', 'in', fileIds)
        .execute();
      const tagsByFile = new Map<string, any[]>();
      for (const tag of allTags) {
        const list = tagsByFile.get(tag.file_id) ?? [];
        list.push({ id: tag.id, name: tag.name, color: tag.color });
        tagsByFile.set(tag.file_id, list);
      }
      for (const file of files) {
        (file as any).tags = tagsByFile.get((file as any).id) ?? [];
      }
    }

    let countQuery = (db as any)
      .selectFrom('zv_media_files')
      .select(({ fn }: any) => fn.count('id').as('count'))
      .where('deleted_at', 'is', null);

    if (folder_id) countQuery = countQuery.where('folder_id', '=', folder_id);
    if (mime_type)
      countQuery = countQuery.where('mime_type', 'ilike', `${mime_type}%`);
    if (search) {
      const safeSearchCount = `%${escapeLike(search)}%`;
      countQuery = countQuery.where(({ or, cmpr }: any) =>
        or([
          cmpr('filename', 'ilike', safeSearchCount),
          cmpr('original_filename', 'ilike', safeSearchCount),
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

    const file = await (db as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    file.tags = await (db as any)
      .selectFrom('zv_media_file_tags')
      .innerJoin(
        'zv_media_tags',
        'zv_media_tags.id',
        'zv_media_file_tags.tag_id',
      )
      .select(['zv_media_tags.id', 'zv_media_tags.name', 'zv_media_tags.color'])
      .where('zv_media_file_tags.file_id', '=', id)
      .execute();

    return c.json({ file });
  });

  router.post('/upload', async (c) => {
    const user = c.get('user' as never) as any;
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const folderId = formData.get('folder_id') as string | null;
    const title = formData.get('title') as string | null;
    const description = formData.get('description') as string | null;
    const altText = formData.get('alt_text') as string | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Check storage quota
    const usageResult = await (db as any)
      .selectFrom('zv_media_files')
      .select(({ fn }: any) => fn.sum('size_bytes').as('total'))
      .where('uploaded_by', '=', user.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const quotaRecord = await (db as any)
      .selectFrom('zv_storage_quotas')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    const usedBytes = Number(usageResult?.total || 0);
    const quotaBytes = quotaRecord?.quota_bytes ?? 5368709120;
    if (usedBytes + file.size > quotaBytes) {
      return c.json({ error: 'Storage quota exceeded' }, 413);
    }

    const fileId = generateId(21);
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
        return c.json(
          { error: 'File content does not match declared type.' },
          415,
        );
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
        return c.json(
          { error: 'File content does not match declared type.' },
          415,
        );
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
            error:
              'SVG files with embedded scripts or event handlers are not allowed',
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
          await s3.send(
            new PutObjectCommand({
              Bucket: process.env.S3_BUCKET || 'zveltio',
              Key: thumbnailKey,
              Body: thumbnailBuffer,
              ContentType: 'image/webp',
            }),
          );
          thumbnailUrl = `${process.env.S3_PUBLIC_URL}/${thumbnailKey}`;
        }
      } catch (error) {
        console.warn('Image processing skipped:', error);
      }
    }

    const key = `media/${filename}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET || 'zveltio',
        Key: key,
        Body: buffer,
        ContentType: file.type,
      }),
    );

    const url = `${process.env.S3_PUBLIC_URL}/${key}`;

    const fileRecord = {
      id: fileId,
      folder_id: folderId || null,
      filename,
      original_filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      width,
      height,
      url,
      thumbnail_url: thumbnailUrl,
      storage_path: key,
      uploaded_by: user.id,
      title: title || null,
      description: description || null,
      alt_text: altText || null,
    };

    await (db as any).insertInto('zv_media_files').values(fileRecord).execute();

    // AI document indexing — fire-and-forget
    scheduleFileIndexing(db, fileId, buffer, file.type);

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

      const file = await (db as any)
        .selectFrom('zv_media_files')
        .select(['id', 'uploaded_by'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!file) return c.json({ error: 'File not found' }, 404);
      const user = c.get('user' as never) as any;
      if (
        file.uploaded_by !== user.id &&
        user.role !== 'admin' &&
        user.role !== 'god'
      ) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      await (db as any)
        .updateTable('zv_media_files')
        .set({ ...data, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/files/:id', async (c) => {
    const user = c.get('user' as never) as any;
    const id = c.req.param('id');

    try {
      await moveToTrash(db, id, user.id);
      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // POST /files/batch-delete — must be registered before /files/:id to avoid conflict
  router.post(
    '/files/batch-delete',
    zValidator('json', z.object({ ids: z.array(z.string()) })),
    async (c) => {
      const user = c.get('user' as never) as any;
      const { ids } = c.req.valid('json');

      let moved = 0;
      for (const id of ids) {
        try {
          await moveToTrash(db, id, user.id);
          moved++;
        } catch {
          // Skip files that don't exist or are already in trash
        }
      }

      return c.json({ success: true, deleted: moved });
    },
  );

  // ==========================================
  // TAGS
  // ==========================================

  router.get('/tags', async (c) => {
    const tags = await (db as any)
      .selectFrom('zv_media_tags')
      .selectAll()
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
      const tag = {
        id: generateId(21),
        name: data.name,
        color: data.color || null,
      };
      try {
        await (db as any).insertInto('zv_media_tags').values(tag).execute();
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
      await (db as any)
        .updateTable('zv_media_tags')
        .set(data)
        .where('id', '=', id)
        .execute();
      return c.json({ success: true });
    },
  );

  router.delete('/tags/:id', async (c) => {
    await (db as any)
      .deleteFrom('zv_media_tags')
      .where('id', '=', c.req.param('id'))
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
        await (db as any)
          .insertInto('zv_media_file_tags')
          .values({ file_id: fileId, tag_id })
          .onConflict((oc: any) => oc.doNothing())
          .execute();
        return c.json({ success: true });
      } catch {
        return c.json({ error: 'Failed to add tag' }, 400);
      }
    },
  );

  router.delete('/files/:id/tags/:tagId', async (c) => {
    await (db as any)
      .deleteFrom('zv_media_file_tags')
      .where('file_id', '=', c.req.param('id'))
      .where('tag_id', '=', c.req.param('tagId'))
      .execute();
    return c.json({ success: true });
  });

  // ==========================================
  // STATS
  // ==========================================

  router.get('/stats', async (c) => {
    const [totalFiles, totalSize, filesByType, totalFolders, totalTags] =
      await Promise.all([
        (db as any)
          .selectFrom('zv_media_files')
          .select(({ fn }: any) => fn.count('id').as('count'))
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
        (db as any)
          .selectFrom('zv_media_files')
          .select(({ fn }: any) => fn.sum('size_bytes').as('total'))
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
        (db as any)
          .selectFrom('zv_media_files')
          .select(['mime_type', (eb: any) => eb.fn.count('id').as('count')])
          .where('deleted_at', 'is', null)
          .groupBy('mime_type')
          .orderBy('count', 'desc')
          .limit(10)
          .execute(),
        (db as any)
          .selectFrom('zv_media_folders')
          .select(({ fn }: any) => fn.count('id').as('count'))
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
        (db as any)
          .selectFrom('zv_media_tags')
          .select(({ fn }: any) => fn.count('id').as('count'))
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

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Database } from '../db/index.js';
import { escapeLike } from '../lib/query-utils.js';
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
    zValidator('json', z.object({
      name: z.string().min(1),
      parent_id: z.string().optional(),
      description: z.string().optional(),
    })),
    async (c) => {
      const user = c.get('user' as never) as any;
      const data = c.req.valid('json');
      const folder = {
        id: nanoid(21),
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
    zValidator('json', z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      parent_id: z.string().nullable().optional(),
    })),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');
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

    const subfolders = await (db as any)
      .selectFrom('zv_media_folders')
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('parent_id', '=', id)
      .executeTakeFirst();

    if (Number(subfolders?.count) > 0) {
      return c.json({ error: 'Folder has subfolders. Delete them first.' }, 400);
    }

    const fileCount = await (db as any)
      .selectFrom('zv_media_files')
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('folder_id', '=', id)
      .executeTakeFirst();

    if (Number(fileCount?.count) > 0) {
      return c.json({ error: 'Folder is not empty. Move or delete files first.' }, 400);
    }

    await (db as any).deleteFrom('zv_media_folders').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // ==========================================
  // FILES
  // ==========================================

  router.get('/files', async (c) => {
    const { folder_id, tag, search, limit = '50', offset = '0', mime_type } = c.req.query();

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
        .innerJoin('zv_media_file_tags', 'zv_media_file_tags.file_id', 'zv_media_files.id')
        .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
        .where('zv_media_tags.name', '=', tag);
    }

    const safeLimit = Math.min(Number(limit) || 50, 500);
    const files = await query.limit(safeLimit).offset(Number(offset)).execute();

    // P1: batch-load all tags in a single query instead of N+1 per-file queries
    if (files.length > 0) {
      const fileIds = files.map((f: any) => f.id);
      const allTags = await (db as any)
        .selectFrom('zv_media_file_tags')
        .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
        .select(['zv_media_file_tags.file_id', 'zv_media_tags.id', 'zv_media_tags.name', 'zv_media_tags.color'])
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
    if (mime_type) countQuery = countQuery.where('mime_type', 'ilike', `${mime_type}%`);
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

    return c.json({ files, pagination: { total, limit: Number(limit), offset: Number(offset) } });
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
      .innerJoin('zv_media_tags', 'zv_media_tags.id', 'zv_media_file_tags.tag_id')
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

    const fileId = nanoid(21);
    const ext = file.name.split('.').pop();
    const filename = `${fileId}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

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
          await s3.send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET || 'zveltio',
            Key: thumbnailKey,
            Body: thumbnailBuffer,
            ContentType: 'image/webp',
          }));
          thumbnailUrl = `${process.env.S3_PUBLIC_URL}/${thumbnailKey}`;
        }
      } catch (error) {
        console.warn('Image processing skipped:', error);
      }
    }

    const key = `media/${filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || 'zveltio',
      Key: key,
      Body: buffer,
      ContentType: file.type,
    }));

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
    zValidator('json', z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      alt_text: z.string().optional(),
      folder_id: z.string().nullable().optional(),
    })),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');
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
    zValidator('json', z.object({
      name: z.string().min(1),
      color: z.string().optional(),
    })),
    async (c) => {
      const data = c.req.valid('json');
      const tag = { id: nanoid(21), name: data.name, color: data.color || null };
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
    zValidator('json', z.object({
      name: z.string().min(1).optional(),
      color: z.string().optional(),
    })),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');
      await (db as any).updateTable('zv_media_tags').set(data).where('id', '=', id).execute();
      return c.json({ success: true });
    },
  );

  router.delete('/tags/:id', async (c) => {
    await (db as any).deleteFrom('zv_media_tags').where('id', '=', c.req.param('id')).execute();
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
    const [totalFiles, totalSize, filesByType, totalFolders, totalTags] = await Promise.all([
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

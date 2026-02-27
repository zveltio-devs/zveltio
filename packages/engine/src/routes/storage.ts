import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3: S3Client | null = null;

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
    const { folder_id, limit = '50', page = '1' } = c.req.query();
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = (db as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (folder_id) query = query.where('folder_id', '=', folder_id);
    else query = query.where('folder_id', 'is', null);

    const files = await query.offset(offset).limit(parseInt(limit)).execute();
    return c.json({ files });
  });

  // POST /upload — Upload a file
  app.post('/upload', async (c) => {
    const user = c.get('user') as any;
    const client = getS3();
    const bucket = process.env.S3_BUCKET || 'zveltio';

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

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

    // Determine dimensions for images
    let width: number | undefined;
    let height: number | undefined;

    const record = await (db as any)
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
    const file = await (db as any)
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

    const file = await (db as any)
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

  // DELETE /:id — Delete file
  app.delete('/:id', async (c) => {
    const client = getS3();
    const file = await (db as any)
      .selectFrom('zv_media_files')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!file) return c.json({ error: 'File not found' }, 404);

    if (client) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET || 'zveltio',
          Key: (file as any).storage_path,
        }),
      ).catch(() => { /* non-fatal if file missing from storage */ });
    }

    await (db as any).deleteFrom('zv_media_files').where('id', '=', (file as any).id).execute();
    return c.json({ success: true });
  });

  // GET /folders — List folders
  app.get('/folders', async (c) => {
    const folders = await (db as any)
      .selectFrom('zv_media_folders')
      .selectAll()
      .orderBy('name')
      .execute();
    return c.json({ folders });
  });

  // POST /folders — Create folder
  app.post('/folders', async (c) => {
    const user = c.get('user') as any;
    const { name, parent_id } = await c.req.json();

    if (!name) return c.json({ error: 'Folder name required' }, 400);

    const folder = await (db as any)
      .insertInto('zv_media_folders')
      .values({ name, parent_id: parent_id || null, created_by: user.id })
      .returningAll()
      .executeTakeFirst();

    return c.json({ folder }, 201);
  });

  return app;
}

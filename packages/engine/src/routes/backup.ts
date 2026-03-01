import { Hono } from 'hono';
import { sql } from 'kysely';
import { checkPermission } from '../lib/permissions.js';
import type { Database } from '../db/index.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/zveltio-backups';

export function backupRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  // Auth + admin guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // GET /api/backup — list backups
  router.get('/', async (c) => {
    const result = await sql<{
      id: string;
      filename: string;
      size_bytes: number | null;
      status: string;
      created_by: string | null;
      created_at: Date;
      completed_at: Date | null;
      notes: string | null;
    }>`
      SELECT id::text, filename, size_bytes, status, created_by, created_at, completed_at, notes
      FROM zv_backups
      ORDER BY created_at DESC
      LIMIT 20
    `.execute(db);

    const backups = result.rows.map((row) => ({
      ...row,
      size_human: row.size_bytes ? formatBytes(row.size_bytes) : null,
    }));

    return c.json({ backups });
  });

  // GET /api/backup/config
  router.get('/config', async (c) => {
    return c.json({ backup_dir: BACKUP_DIR, max_backups: 20 });
  });

  // POST /api/backup — create backup (async background)
  router.post('/', async (c) => {
    const user = c.get('user' as never) as any;
    const body = await c.req.json().catch(() => ({}));
    const notes = body.notes || null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sql.gz`;
    const filepath = `${BACKUP_DIR}/${filename}`;

    const backupResult = await sql<{ id: string }>`
      INSERT INTO zv_backups (filename, status, created_by, notes)
      VALUES (${filename}, 'in_progress', ${user.id}, ${notes})
      RETURNING id::text
    `.execute(db);
    const backupId = backupResult.rows[0].id;

    // Build DB connection params
    const dbHost = process.env.DATABASE_HOST_DIRECT || process.env.DATABASE_HOST || 'localhost';
    const dbPort = process.env.DATABASE_PORT_DIRECT || process.env.DATABASE_PORT || '5432';
    const dbName = process.env.DATABASE_NAME || 'zveltio_dev';
    const dbUser = process.env.DATABASE_USER || 'postgres';
    const dbPassword = process.env.DATABASE_PASSWORD || '';

    // Run backup in background — do NOT await
    const backupBg = async () => {
      try {
        // Ensure backup directory exists
        const mkdirProc = Bun.spawn(['mkdir', '-p', BACKUP_DIR]);
        await mkdirProc.exited;

        // pg_dump piped through gzip into file
        const pgdumpProc = Bun.spawn(
          ['pg_dump', '-h', dbHost, '-p', String(dbPort), '-U', dbUser, '-d', dbName],
          {
            env: { ...process.env, PGPASSWORD: dbPassword } as Record<string, string>,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );

        const gzipProc = Bun.spawn(['gzip', '-c'], {
          stdin: pgdumpProc.stdout,
          stdout: Bun.file(filepath),
        });

        await Promise.all([pgdumpProc.exited, gzipProc.exited]);

        if (pgdumpProc.exitCode !== 0) {
          const stderr = await new Response(pgdumpProc.stderr).text();
          throw new Error(`pg_dump failed (exit ${pgdumpProc.exitCode}): ${stderr}`);
        }

        if (!(await Bun.file(filepath).exists())) {
          throw new Error('Backup file was not created');
        }

        const size = Bun.file(filepath).size;

        await sql`
          UPDATE zv_backups
          SET status = 'completed', size_bytes = ${size}, completed_at = NOW()
          WHERE id = ${backupId}
        `.execute(db);

        await cleanupOldBackups(db);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('Backup failed:', msg);

        await sql`
          UPDATE zv_backups
          SET status = 'failed', error = ${msg}
          WHERE id = ${backupId}
        `.execute(db);

        // Clean up partial file
        if (await Bun.file(filepath).exists()) {
          const rmProc = Bun.spawn(['rm', '-f', filepath]);
          await rmProc.exited;
        }
      }
    };

    backupBg().catch((err) => console.error('Backup bg error:', err));

    return c.json({ backup_id: backupId, status: 'in_progress', filename });
  });

  // GET /api/backup/:id/status
  router.get('/:id/status', async (c) => {
    const id = c.req.param('id');

    const result = await sql<{
      id: string;
      status: string;
      size_bytes: number | null;
      completed_at: Date | null;
      error: string | null;
    }>`
      SELECT id::text, status, size_bytes, completed_at, error
      FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (!result.rows[0]) return c.json({ error: 'Not found' }, 404);

    return c.json({
      ...result.rows[0],
      size_human: result.rows[0].size_bytes ? formatBytes(result.rows[0].size_bytes) : null,
    });
  });

  // GET /api/backup/:id/download
  router.get('/:id/download', async (c) => {
    const id = c.req.param('id');

    const backup = await sql<{ filename: string; status: string }>`
      SELECT filename, status FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (!backup.rows[0]) return c.json({ error: 'Backup not found' }, 404);
    if (backup.rows[0].status !== 'completed') return c.json({ error: 'Backup not ready' }, 400);

    const { filename } = backup.rows[0];

    // Security: only allow safe filenames (no path traversal)
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filepath = `${BACKUP_DIR}/${filename}`;

    if (!(await Bun.file(filepath).exists())) {
      return c.json({ error: 'Backup file not found on disk' }, 404);
    }

    const bunFile = Bun.file(filepath);
    const buffer = await bunFile.arrayBuffer();

    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(bunFile.size),
      },
    });
  });

  // DELETE /api/backup/:id
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');

    const backup = await sql<{ filename: string }>`
      SELECT filename FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (backup.rows[0]) {
      const { filename } = backup.rows[0];
      if (!filename.includes('..') && !filename.includes('/')) {
        const filepath = `${BACKUP_DIR}/${filename}`;
        if (await Bun.file(filepath).exists()) {
          const rmProc = Bun.spawn(['rm', '-f', filepath]);
          await rmProc.exited;
        }
      }
      await sql`DELETE FROM zv_backups WHERE id = ${id}`.execute(db);
    }

    return c.json({ success: true });
  });

  return router;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function cleanupOldBackups(db: Database): Promise<void> {
  try {
    const oldBackups = await sql<{ id: string; filename: string }>`
      SELECT id::text, filename FROM zv_backups
      WHERE status = 'completed'
      ORDER BY created_at DESC
      OFFSET 20
    `.execute(db);

    for (const backup of oldBackups.rows) {
      if (!backup.filename.includes('..') && !backup.filename.includes('/')) {
        const filepath = `${BACKUP_DIR}/${backup.filename}`;
        if (await Bun.file(filepath).exists()) {
          const rmProc = Bun.spawn(['rm', '-f', filepath]);
          await rmProc.exited;
        }
      }
      await sql`DELETE FROM zv_backups WHERE id = ${backup.id}`.execute(db);
    }
  } catch (err) {
    console.error('Failed to cleanup old backups:', err);
  }
}

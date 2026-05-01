import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'kysely';
import { z } from 'zod';
import { createHash } from 'crypto';
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

  // ── PITR routes ────────────────────────────────────────────────────────────

  router.get('/pitr/config', async (c) => {
    const result = await sql<{
      id: string; is_enabled: boolean; wal_archive_path: string | null;
      retention_days: number; last_base_backup_at: Date | null;
      last_wal_segment: string | null; updated_at: Date;
    }>`SELECT id::text, is_enabled, wal_archive_path, retention_days,
         last_base_backup_at, last_wal_segment, updated_at
       FROM zv_pitr_config LIMIT 1`.execute(db);
    if (!result.rows[0]) return c.json({ error: 'PITR config not found' }, 404);
    return c.json({ config: result.rows[0] });
  });

  const PitrConfigSchema = z.object({
    is_enabled: z.boolean().optional(),
    retention_days: z.number().int().min(1).max(365).optional(),
    wal_archive_path: z.string().nullable().optional(),
  });

  router.patch('/pitr/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = PitrConfigSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { is_enabled, retention_days, wal_archive_path } = parsed.data;
    await sql`UPDATE zv_pitr_config SET
        is_enabled       = COALESCE(${is_enabled ?? null}::boolean, is_enabled),
        retention_days   = COALESCE(${retention_days ?? null}::int, retention_days),
        wal_archive_path = CASE WHEN ${wal_archive_path !== undefined} THEN ${wal_archive_path ?? null}
                               ELSE wal_archive_path END,
        updated_at = NOW()
      WHERE id = (SELECT id FROM zv_pitr_config LIMIT 1)`.execute(db);
    const result = await sql<{
      id: string; is_enabled: boolean; wal_archive_path: string | null;
      retention_days: number; updated_at: Date;
    }>`SELECT id::text, is_enabled, wal_archive_path, retention_days, updated_at
       FROM zv_pitr_config LIMIT 1`.execute(db);
    return c.json({ config: result.rows[0] });
  });

  router.get('/pitr/restore-points', async (c) => {
    const result = await sql<{
      id: string; name: string; description: string | null;
      lsn: string | null; recorded_at: Date; created_by: string | null;
    }>`SELECT id::text, name, description, lsn, recorded_at, created_by::text
       FROM zv_pitr_restore_points ORDER BY recorded_at DESC LIMIT 100`.execute(db);
    return c.json({ restore_points: result.rows });
  });

  const CreateRestorePointSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
  });

  router.post('/pitr/restore-points', async (c) => {
    const user = c.get('user' as never) as any;
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateRestorePointSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { name, description } = parsed.data;
    const lsnResult = await sql<{ lsn: string }>`
      SELECT pg_current_wal_lsn()::text AS lsn`.execute(db);
    const lsn = lsnResult.rows[0]?.lsn ?? null;
    const insertResult = await sql<{ id: string; recorded_at: Date }>`
      INSERT INTO zv_pitr_restore_points (name, description, lsn, created_by)
      VALUES (${name}, ${description ?? null}, ${lsn}, ${user.id})
      RETURNING id::text, recorded_at`.execute(db);
    return c.json({ restore_point: { ...insertResult.rows[0], name, description, lsn } }, 201);
  });

  router.delete('/pitr/restore-points/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await sql<{ id: string }>`
      SELECT id::text FROM zv_pitr_restore_points WHERE id = ${id}`.execute(db);
    if (!existing.rows[0]) return c.json({ error: 'Restore point not found' }, 404);
    await sql`DELETE FROM zv_pitr_restore_points WHERE id = ${id}`.execute(db);
    return c.json({ success: true });
  });

  const PitrRestoreSchema = z.object({
    restore_point_id: z.string().uuid().optional(),
    target_time: z.string().datetime().optional(),
  }).refine((d) => d.restore_point_id || d.target_time, {
    message: 'Provide either restore_point_id or target_time',
  });

  router.post('/pitr/restore', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = PitrRestoreSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { restore_point_id, target_time } = parsed.data;
    let resolvedTime = target_time;
    if (restore_point_id) {
      const rp = await sql<{ recorded_at: Date; lsn: string | null }>`
        SELECT recorded_at, lsn FROM zv_pitr_restore_points WHERE id = ${restore_point_id}`.execute(db);
      if (!rp.rows[0]) return c.json({ error: 'Restore point not found' }, 404);
      resolvedTime = new Date(rp.rows[0].recorded_at).toISOString();
    }
    const cfgResult = await sql<{ wal_archive_path: string | null }>`
      SELECT wal_archive_path FROM zv_pitr_config LIMIT 1`.execute(db);
    const walPath = cfgResult.rows[0]?.wal_archive_path ?? '/var/lib/wal-g/archive';
    return c.json({
      message: 'PITR restore instructions generated. This operation requires manual intervention.',
      target_time: resolvedTime,
      restore_point_id: restore_point_id ?? null,
      instructions: [
        '1. Stop the Zveltio engine and all application servers.',
        '2. Run: wal-g backup-fetch LATEST /var/lib/postgresql/data',
        `3. Create recovery.conf with:\n   restore_command = 'wal-g wal-fetch %f %p'\n   recovery_target_time = '${resolvedTime}'\n   recovery_target_action = 'promote'`,
        `4. Ensure WAL archive is accessible at: ${walPath}`,
        '5. Start PostgreSQL — it will replay WAL segments up to the target time.',
        '6. Restart the Zveltio engine once PostgreSQL is healthy.',
      ],
      warning: 'This will REPLACE your current database with data from the target point in time. All changes after that point will be LOST.',
    });
  });

  router.get('/pitr/status', async (c) => {
    const result = await sql<{ lsn: string; last_checkpoint: string; db_size_bytes: string }>`
      SELECT pg_current_wal_lsn()::text AS lsn,
             pg_last_checkpoint()::text AS last_checkpoint,
             pg_database_size(current_database())::text AS db_size_bytes`.execute(db);
    const row = result.rows[0];
    return c.json({
      current_lsn: row?.lsn ?? null,
      last_checkpoint: row?.last_checkpoint ?? null,
      db_size_bytes: row?.db_size_bytes ? Number(row.db_size_bytes) : null,
      db_size_human: row?.db_size_bytes ? formatBytes(Number(row.db_size_bytes)) : null,
    });
  });

  // ── Enterprise: Schedules ──────────────────────────────────────

  const ScheduleSchema = z.object({
    name: z.string().min(1),
    cron_expression: z.string().min(1),
    retention_count: z.number().int().min(1).default(7),
    storage_destination: z.enum(['local', 's3', 'both']).default('local'),
    s3_bucket: z.string().optional(),
    s3_prefix: z.string().optional(),
    notify_on_failure: z.boolean().default(true),
    notify_emails: z.array(z.string().email()).default([]),
    is_active: z.boolean().default(true),
  });

  // GET /schedules — list backup schedules
  router.get('/schedules', async (c) => {
    const schedules = await sql<any>`
      SELECT id::text, name, cron_expression, retention_count,
             storage_destination, s3_bucket, s3_prefix,
             notify_on_failure, notify_emails, is_active,
             last_run_at, last_run_status, next_run_at,
             created_by, created_at, updated_at
      FROM zv_backup_schedules
      ORDER BY created_at DESC
    `.execute(db);

    return c.json({ schedules: schedules.rows });
  });

  // POST /schedules — create schedule
  router.post('/schedules', zValidator('json', ScheduleSchema), async (c) => {
    const user = c.get('user' as never) as any;
    const data = c.req.valid('json');

    const result = await sql<{ id: string }>`
      INSERT INTO zv_backup_schedules (
        name, cron_expression, retention_count, storage_destination,
        s3_bucket, s3_prefix, notify_on_failure, notify_emails,
        is_active, created_by
      ) VALUES (
        ${data.name}, ${data.cron_expression}, ${data.retention_count},
        ${data.storage_destination}, ${data.s3_bucket ?? null}, ${data.s3_prefix ?? null},
        ${data.notify_on_failure}, ${JSON.stringify(data.notify_emails)},
        ${data.is_active}, ${user.id}
      ) RETURNING id::text
    `.execute(db);

    return c.json({ schedule_id: result.rows[0].id }, 201);
  });

  // PATCH /schedules/:id — update schedule
  router.patch('/schedules/:id', zValidator('json', ScheduleSchema.partial()), async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');

    const existing = await sql<{ id: string }>`
      SELECT id::text FROM zv_backup_schedules WHERE id = ${id}
    `.execute(db);

    if (!existing.rows[0]) return c.json({ error: 'Schedule not found' }, 404);

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: any[] = [];

    if (data.name !== undefined) { setClauses.push(`name = $${values.push(data.name)}`); }
    if (data.cron_expression !== undefined) { setClauses.push(`cron_expression = $${values.push(data.cron_expression)}`); }
    if (data.retention_count !== undefined) { setClauses.push(`retention_count = $${values.push(data.retention_count)}`); }
    if (data.storage_destination !== undefined) { setClauses.push(`storage_destination = $${values.push(data.storage_destination)}`); }
    if (data.s3_bucket !== undefined) { setClauses.push(`s3_bucket = $${values.push(data.s3_bucket)}`); }
    if (data.s3_prefix !== undefined) { setClauses.push(`s3_prefix = $${values.push(data.s3_prefix)}`); }
    if (data.notify_on_failure !== undefined) { setClauses.push(`notify_on_failure = $${values.push(data.notify_on_failure)}`); }
    if (data.notify_emails !== undefined) { setClauses.push(`notify_emails = $${values.push(JSON.stringify(data.notify_emails))}`); }
    if (data.is_active !== undefined) { setClauses.push(`is_active = $${values.push(data.is_active)}`); }

    // Use Kysely updateTable for safety
    const updateData: Record<string, any> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.cron_expression !== undefined) updateData.cron_expression = data.cron_expression;
    if (data.retention_count !== undefined) updateData.retention_count = data.retention_count;
    if (data.storage_destination !== undefined) updateData.storage_destination = data.storage_destination;
    if (data.s3_bucket !== undefined) updateData.s3_bucket = data.s3_bucket;
    if (data.s3_prefix !== undefined) updateData.s3_prefix = data.s3_prefix;
    if (data.notify_on_failure !== undefined) updateData.notify_on_failure = data.notify_on_failure;
    if (data.notify_emails !== undefined) updateData.notify_emails = JSON.stringify(data.notify_emails);
    if (data.is_active !== undefined) updateData.is_active = data.is_active;

    await (db as any)
      .updateTable('zv_backup_schedules')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return c.json({ success: true });
  });

  // DELETE /schedules/:id — delete schedule
  router.delete('/schedules/:id', async (c) => {
    const id = c.req.param('id');
    await sql`DELETE FROM zv_backup_schedules WHERE id = ${id}`.execute(db);
    return c.json({ success: true });
  });

  // POST /schedules/:id/trigger — manually trigger a scheduled backup now
  router.post('/schedules/:id/trigger', async (c) => {
    const user = c.get('user' as never) as any;
    const scheduleId = c.req.param('id');

    const schedule = await sql<{ id: string; name: string }>`
      SELECT id::text, name FROM zv_backup_schedules WHERE id = ${scheduleId} AND is_active = true
    `.execute(db);

    if (!schedule.rows[0]) return c.json({ error: 'Schedule not found or inactive' }, 404);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-schedule-${scheduleId}-${timestamp}.sql.gz`;
    const filepath = `${BACKUP_DIR}/${filename}`;

    const backupResult = await sql<{ id: string }>`
      INSERT INTO zv_backups (filename, status, created_by, notes)
      VALUES (${filename}, 'in_progress', ${user.id}, ${'Triggered by schedule: ' + schedule.rows[0].name})
      RETURNING id::text
    `.execute(db);
    const backupId = backupResult.rows[0].id;

    const dbHost = process.env.DATABASE_HOST_DIRECT || process.env.DATABASE_HOST || 'localhost';
    const dbPort = process.env.DATABASE_PORT_DIRECT || process.env.DATABASE_PORT || '5432';
    const dbName = process.env.DATABASE_NAME || 'zveltio_dev';
    const dbUser = process.env.DATABASE_USER || 'postgres';
    const dbPassword = process.env.DATABASE_PASSWORD || '';

    const backupBg = async () => {
      try {
        const mkdirProc = Bun.spawn(['mkdir', '-p', BACKUP_DIR]);
        await mkdirProc.exited;

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
          UPDATE zv_backups SET status = 'completed', size_bytes = ${size}, completed_at = NOW()
          WHERE id = ${backupId}
        `.execute(db);

        await sql`
          UPDATE zv_backup_schedules
          SET last_run_at = NOW(), last_run_status = 'completed'
          WHERE id = ${scheduleId}
        `.execute(db);

        await cleanupOldBackups(db);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('Scheduled backup failed:', msg);
        await sql`
          UPDATE zv_backups SET status = 'failed', error = ${msg} WHERE id = ${backupId}
        `.execute(db);
        await sql`
          UPDATE zv_backup_schedules SET last_run_at = NOW(), last_run_status = 'failed' WHERE id = ${scheduleId}
        `.execute(db);
      }
    };

    backupBg().catch((err) => console.error('Scheduled backup bg error:', err));

    return c.json({ backup_id: backupId, status: 'in_progress', filename, schedule_id: scheduleId });
  });

  // ── Enterprise: Integrity Checks ──────────────────────────────

  // GET /integrity/:id — get integrity check result for a backup
  router.get('/integrity/:id', async (c) => {
    const backupId = c.req.param('id');

    const checks = await sql<any>`
      SELECT id::text, backup_id, filename, size_bytes, checksum_md5, is_valid, error, checked_at
      FROM zv_backup_integrity_checks
      WHERE backup_id = ${backupId}
      ORDER BY checked_at DESC
      LIMIT 10
    `.execute(db);

    return c.json({ backup_id: backupId, checks: checks.rows });
  });

  // POST /integrity/:id — run integrity check on a backup
  router.post('/integrity/:id', async (c) => {
    const id = c.req.param('id');

    const backup = await sql<{ filename: string; status: string; size_bytes: number | null }>`
      SELECT filename, status, size_bytes FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (!backup.rows[0]) return c.json({ error: 'Backup not found' }, 404);

    const { filename } = backup.rows[0];

    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filepath = `${BACKUP_DIR}/${filename}`;
    const bunFile = Bun.file(filepath);

    let isValid = false;
    let checksumMd5: string | null = null;
    let errorMsg: string | null = null;
    let actualSize: number | null = null;

    try {
      if (!(await bunFile.exists())) {
        throw new Error('Backup file not found on disk');
      }

      actualSize = bunFile.size;
      const buffer = await bunFile.arrayBuffer();
      checksumMd5 = createHash('md5').update(Buffer.from(buffer)).digest('hex');
      isValid = true;
    } catch (err: any) {
      errorMsg = err.message;
      isValid = false;
    }

    const result = await sql<{ id: string }>`
      INSERT INTO zv_backup_integrity_checks (backup_id, filename, size_bytes, checksum_md5, is_valid, error)
      VALUES (${id}, ${filename}, ${actualSize}, ${checksumMd5}, ${isValid}, ${errorMsg})
      RETURNING id::text
    `.execute(db);

    return c.json({
      check_id: result.rows[0].id,
      backup_id: id,
      filename,
      size_bytes: actualSize,
      checksum_md5: checksumMd5,
      is_valid: isValid,
      error: errorMsg,
    });
  });

  // ── Enterprise: Stats ──────────────────────────────────────────

  // GET /stats — backup statistics
  router.get('/stats', async (c) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const totalResult = await sql<{ count: string; total_size: string | null }>`
      SELECT COUNT(*) as count, SUM(size_bytes)::text as total_size
      FROM zv_backups WHERE status = 'completed'
    `.execute(db);

    const lastSuccessResult = await sql<{ created_at: Date; filename: string }>`
      SELECT created_at, filename FROM zv_backups
      WHERE status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `.execute(db);

    const recentTotalResult = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zv_backups WHERE created_at >= ${thirtyDaysAgo}
    `.execute(db);

    const recentSuccessResult = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zv_backups
      WHERE status = 'completed' AND created_at >= ${thirtyDaysAgo}
    `.execute(db);

    const scheduleCountResult = await sql<{ count: string }>`
      SELECT COUNT(*) as count FROM zv_backup_schedules WHERE is_active = true
    `.execute(db);

    const recentTotal = parseInt(recentTotalResult.rows[0]?.count || '0');
    const recentSuccess = parseInt(recentSuccessResult.rows[0]?.count || '0');
    const successRate = recentTotal > 0 ? Math.round((recentSuccess / recentTotal) * 100) : 100;

    return c.json({
      total_backups: parseInt(totalResult.rows[0]?.count || '0'),
      total_size_bytes: totalResult.rows[0]?.total_size ? parseInt(totalResult.rows[0].total_size) : 0,
      total_size_human: totalResult.rows[0]?.total_size ? formatBytes(parseInt(totalResult.rows[0].total_size)) : '0 B',
      last_successful_backup: lastSuccessResult.rows[0] ?? null,
      success_rate_30d: successRate,
      active_schedule_count: parseInt(scheduleCountResult.rows[0]?.count || '0'),
    });
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

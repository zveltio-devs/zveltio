import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'kysely';
import { z } from 'zod';
import { createHash } from 'crypto';
import { unlink } from 'node:fs/promises';
import { isGodUser, getCurrentDomain, requireInstanceAdmin } from '../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../lib/tenancy/index.js';
import { auditLog } from '../lib/audit.js';
import { getStorage } from '../lib/storage/index.js';
import { runScheduledBackup } from '../lib/backup/run-scheduled-backup.js';
import { setNextRun } from '../lib/backup/scheduler.js';
import type { Database } from '../db/index.js';
import { toNumber, toNumberOrNull, toNumberSafe } from '../lib/numeric.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/zveltio-backups';

/**
 * Say what an RLS-blocked `pg_dump` means, because Postgres's own hint is
 * dangerous here.
 *
 * On the hardened install — the one `docs/platform/deployment-k8s.md` recommends and
 * `scripts/bootstrap-db-role.sh` builds — the engine's role is
 * `NOSUPERUSER NOBYPASSRLS` and owns the tables. `FORCE ROW LEVEL SECURITY`
 * binds the owner too, and `pg_dump` refuses to dump a table whose rows it
 * cannot prove are complete. So it fails, on a VIRGIN install with no
 * collections at all: `zv_edge_function_logs` ships with FORCE RLS from
 * migration 049. Measured, not inferred.
 *
 * Postgres ends that error with:
 *
 *   HINT: To disable the policy for the table's owner, use
 *         ALTER TABLE NO FORCE ROW LEVEL SECURITY.
 *
 * Which is correct advice for Postgres and wrong advice here: that statement
 * removes the boundary between tenants on that table. An operator whose backups
 * are failing, reading a hint from the database itself, is exactly the person
 * likely to run it. So the hint is answered rather than passed through.
 *
 * `--enable-row-security` is the other tempting fix and is worse: pg_dump then
 * dumps only the rows the role can SEE, which without tenant context is the
 * default tenant's. That produces a backup that succeeds, weighs about right,
 * and silently omits every other tenant. A backup that lies is worse than a
 * backup that fails.
 */
export function explainDumpFailure(stderr: string): string {
  if (!/row-level security|row level security/i.test(stderr)) return stderr;
  return (
    `${stderr}\n` +
    '\n--- Zveltio ---\n' +
    "This is not a corrupt database. The engine's role is bound by FORCE ROW LEVEL\n" +
    'SECURITY, so pg_dump will not dump tables it cannot read completely.\n' +
    '\n' +
    'DO NOT follow the HINT above. `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`\n' +
    'removes the tenant boundary on that table — it would fix the backup by\n' +
    'switching off the isolation the backup exists to protect.\n' +
    '\n' +
    'DO NOT add `--enable-row-security` either: pg_dump would then dump only the\n' +
    "rows this role can see, which with no tenant context is the default tenant's.\n" +
    'The backup would succeed and silently omit every other tenant.\n' +
    '\n' +
    'Back up as a role that RLS does not bind — one created with BYPASSRLS, kept\n' +
    "apart from the engine's own role and used for nothing else. See\n" +
    'docs/platform/disaster-recovery.md.'
  );
}

/**
 * Where `pg_dump` should connect, resolved once instead of twice.
 *
 * There were two copies. `POST /` parsed `DATABASE_URL` when the individual
 * vars were absent; `POST /schedules/:id/trigger` did not — it read only
 * `DATABASE_HOST`/`NAME`/`USER`/`PASSWORD` and fell back to
 * `localhost`/`zveltio_dev`/`postgres`/`''`.
 *
 * On the documented install, which sets `DATABASE_URL` and nothing else, that
 * second copy aimed at a database called `zveltio_dev` as user `postgres` with
 * no password. So a scheduled backup either failed at the password prompt or,
 * on a machine that happens to have a `zveltio_dev` lying around, dumped the
 * WRONG DATABASE and recorded success.
 *
 * Measured: triggering a schedule on an engine started with only `DATABASE_URL`
 * produced `pg_dump failed (exit 1): Password:` while `POST /` on the same
 * engine worked.
 */
export function resolveDumpTarget(): {
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
} {
  let host = process.env.DATABASE_HOST_DIRECT || process.env.DATABASE_HOST || '';
  let port = process.env.DATABASE_PORT_DIRECT || process.env.DATABASE_PORT || '';
  let name = process.env.DATABASE_NAME || '';
  let user = process.env.DATABASE_USER || '';
  let password = process.env.DATABASE_PASSWORD || '';

  if (!host || !name || !user) {
    const rawUrl = process.env.DATABASE_URL || process.env.NATIVE_DATABASE_URL || '';
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (!host) host = u.hostname;
        if (!port) port = u.port || '5432';
        if (!name) name = u.pathname.replace(/^\//, '');
        if (!user) user = u.username;
        if (!password) password = decodeURIComponent(u.password);
      } catch {
        /* malformed URL — keep what we have */
      }
    }
  }

  // The backup role, when one exists — see `explainDumpFailure` for why the
  // engine's own role usually cannot dump this database at all.
  if (process.env.BACKUP_DB_USER) {
    user = process.env.BACKUP_DB_USER;
    password = process.env.BACKUP_DB_PASSWORD || '';
  }

  return {
    host: host || 'localhost',
    port: port || '5432',
    name: name || 'zveltio_dev',
    user: user || 'postgres',
    password,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function backupRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  // Auth + admin guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    if (!(await requireInstanceAdmin(session.user.id))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    // Backups are whole-instance operations: a pg_dump captures EVERY tenant's
    // data and a PITR restore rewrites the entire instance. A per-tenant admin
    // must not trigger those. In the default/root tenant (single-tenant
    // deployments) admin:* is the instance owner, so this is a no-op there;
    // outside it, require the top-level god role.
    if (getCurrentDomain() !== DEFAULT_TENANT_ID && !(await isGodUser(session.user.id))) {
      return c.json({ error: 'Instance-wide backups require the god role' }, 403);
    }
    await next();
  });

  // GET /api/backup — list backups
  router.get('/', async (c) => {
    const result = await sql<{
      id: string;
      filename: string;
      size_bytes: string | null; // BIGINT — the driver returns a string
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
      size_human: row.size_bytes === null ? null : formatBytes(row.size_bytes),
    }));

    return c.json({ backups });
  });

  // GET /api/backup/config
  router.get('/config', async (c) => {
    return c.json({ backup_dir: BACKUP_DIR, max_backups: 20 });
  });

  // POST /api/backup — create backup (async background)
  router.post('/', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

    // One resolver for both routes — see `resolveDumpTarget`. The copy that used
    // to live here and the copy in the schedule trigger had drifted, and only
    // one of them read `DATABASE_URL`.
    const {
      host: dbHost,
      port: dbPort,
      name: dbName,
      user: dbUser,
      password: dbPassword,
    } = resolveDumpTarget();

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
          throw new Error(
            `pg_dump failed (exit ${pgdumpProc.exitCode}): ${explainDumpFailure(stderr)}`,
          );
        }

        if (!(await Bun.file(filepath).exists())) {
          throw new Error('Backup file was not created');
        }

        // Tighten permissions on the dump file: it holds the entire DB
        // including password hashes, secrets, customer PII. The default
        // umask on most Linux installs creates 0644 (world-readable),
        // which on a shared host means any user can `cat` the backup.
        // 0600 = owner read/write only. No-op on Windows.
        if (process.platform !== 'win32') {
          await Bun.spawn(['chmod', '600', filepath]).exited.catch(() => {});
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

    await auditLog(db, {
      type: 'backup.created',
      userId: user.id,
      resourceId: backupId,
      resourceType: 'backup',
      metadata: { filename, notes },
    });
    return c.json({ backup_id: backupId, status: 'in_progress', filename });
  });

  // GET /api/backup/pitr/status — MUST precede /:id/status, else the param
  // route captures "pitr" as :id and the UUID cast on zv_backups.id 500s.
  router.get('/pitr/status', async (c) => {
    // pg_last_checkpoint() does NOT exist in standard Postgres — the
    // correct function is pg_control_checkpoint(), which returns a row
    // with checkpoint_lsn + checkpoint_time among other fields. The old
    // query 500'd on every call against any vanilla PG install.
    const result = await sql<{
      lsn: string;
      last_checkpoint: string | null;
      db_size_bytes: string;
    }>`
      SELECT pg_current_wal_lsn()::text AS lsn,
             (SELECT checkpoint_time::text FROM pg_control_checkpoint()) AS last_checkpoint,
             pg_database_size(current_database())::text AS db_size_bytes`.execute(db);
    const row = result.rows[0];
    return c.json({
      current_lsn: row?.lsn ?? null,
      last_checkpoint: row?.last_checkpoint ?? null,
      db_size_bytes: row?.db_size_bytes ? Number(row.db_size_bytes) : null,
      db_size_human: row?.db_size_bytes ? formatBytes(row.db_size_bytes) : null,
    });
  });

  // GET /api/backup/:id/status
  router.get('/:id/status', async (c) => {
    const id = c.req.param('id');

    const result = await sql<{
      id: string;
      status: string;
      size_bytes: string | null; // BIGINT — the driver returns a string
      completed_at: Date | null;
      error: string | null;
    }>`
      SELECT id::text, status, size_bytes, completed_at, error
      FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (!result.rows[0]) return c.json({ error: 'Not found' }, 404);

    return c.json({
      ...result.rows[0],
      size_human:
        result.rows[0].size_bytes === null ? null : formatBytes(result.rows[0].size_bytes),
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;

    const backup = await sql<{ filename: string }>`
      SELECT filename FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (backup.rows[0]) {
      const { filename } = backup.rows[0];

      // Row first, file second.
      //
      // The other order — which this used to be — leaves, on a failure between
      // them, a row saying a backup exists over a file that is gone. An operator
      // reading the list then believes they hold a restore point they do not,
      // which is the one belief a backup system must never create. The reverse
      // leaves an orphaned file: wasted disk, and nothing else.
      await sql`DELETE FROM zv_backups WHERE id = ${id}`.execute(db);

      if (!filename.includes('..') && !filename.includes('/')) {
        const filepath = `${BACKUP_DIR}/${filename}`;
        // `unlink`, not `Bun.spawn(['rm', …])`. Forking a process to delete one
        // file costs a fork and holds the request open while it waits — and this
        // request is holding a pooled connection meanwhile. See
        // scripts/report-slow-in-transaction.ts.
        await unlink(filepath).catch(() => {
          // Already gone, or never written. The row is what mattered and it is
          // committed; a missing file here is the harmless direction.
        });
      }
      await auditLog(db, {
        type: 'backup.deleted',
        userId: user?.id,
        resourceId: id,
        resourceType: 'backup',
        metadata: { filename: backup.rows[0].filename },
      });
    }

    return c.json({ success: true });
  });

  // ── PITR routes ────────────────────────────────────────────────────────────

  router.get('/pitr/config', async (c) => {
    const result = await sql<{
      id: string;
      is_enabled: boolean;
      wal_archive_path: string | null;
      retention_days: number;
      last_base_backup_at: Date | null;
      last_wal_segment: string | null;
      updated_at: Date;
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
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
      id: string;
      is_enabled: boolean;
      wal_archive_path: string | null;
      retention_days: number;
      updated_at: Date;
    }>`SELECT id::text, is_enabled, wal_archive_path, retention_days, updated_at
       FROM zv_pitr_config LIMIT 1`.execute(db);
    await auditLog(db, {
      type: 'pitr.config_changed',
      userId: user?.id,
      resourceType: 'pitr_config',
      metadata: { is_enabled, retention_days, wal_archive_path },
    });
    return c.json({ config: result.rows[0] });
  });

  router.get('/pitr/restore-points', async (c) => {
    const result = await sql<{
      id: string;
      name: string;
      description: string | null;
      lsn: string | null;
      recorded_at: Date;
      created_by: string | null;
    }>`SELECT id::text, name, description, lsn, recorded_at, created_by::text
       FROM zv_pitr_restore_points ORDER BY recorded_at DESC LIMIT 100`.execute(db);
    return c.json({ restore_points: result.rows });
  });

  const CreateRestorePointSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
  });

  router.post('/pitr/restore-points', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    const restorePointId = insertResult.rows[0]?.id;
    await auditLog(db, {
      type: 'pitr.config_changed',
      userId: user.id,
      resourceId: restorePointId,
      resourceType: 'pitr_restore_point',
      metadata: { name, description, lsn, action: 'create' },
    });
    return c.json({ restore_point: { ...insertResult.rows[0], name, description, lsn } }, 201);
  });

  router.delete('/pitr/restore-points/:id', async (c) => {
    const id = c.req.param('id');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const existing = await sql<{ id: string }>`
      SELECT id::text FROM zv_pitr_restore_points WHERE id = ${id}`.execute(db);
    if (!existing.rows[0]) return c.json({ error: 'Restore point not found' }, 404);
    await sql`DELETE FROM zv_pitr_restore_points WHERE id = ${id}`.execute(db);
    await auditLog(db, {
      type: 'pitr.config_changed',
      userId: user?.id,
      resourceId: id,
      resourceType: 'pitr_restore_point',
      metadata: { action: 'delete' },
    });
    return c.json({ success: true });
  });

  const PitrRestoreSchema = z
    .object({
      restore_point_id: z.string().uuid().optional(),
      target_time: z.string().datetime().optional(),
    })
    .refine((d) => d.restore_point_id || d.target_time, {
      message: 'Provide either restore_point_id or target_time',
    });

  router.post('/pitr/restore', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const body = await c.req.json().catch(() => ({}));
    const parsed = PitrRestoreSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { restore_point_id, target_time } = parsed.data;
    let resolvedTime = target_time;
    if (restore_point_id) {
      const rp = await sql<{ recorded_at: Date; lsn: string | null }>`
        SELECT recorded_at, lsn FROM zv_pitr_restore_points WHERE id = ${restore_point_id}`.execute(
        db,
      );
      if (!rp.rows[0]) return c.json({ error: 'Restore point not found' }, 404);
      resolvedTime = new Date(rp.rows[0].recorded_at).toISOString();
    }
    const cfgResult = await sql<{ wal_archive_path: string | null }>`
      SELECT wal_archive_path FROM zv_pitr_config LIMIT 1`.execute(db);
    const walPath = cfgResult.rows[0]?.wal_archive_path ?? '/var/lib/wal-g/archive';
    await auditLog(db, {
      type: 'pitr.restored',
      userId: user?.id,
      resourceId: restore_point_id ?? undefined,
      resourceType: 'pitr_restore',
      metadata: { target_time: resolvedTime, instructions_only: true },
    });
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
      warning:
        'This will REPLACE your current database with data from the target point in time. All changes after that point will be LOST.',
    });
  });

  // ── Enterprise: Schedules ──────────────────────────────────────
  //
  // A schedule stored here does NOT fire on its own. Nothing reads
  // `cron_expression`: the boot scheduler starts the garbage collector and the
  // trash purge and nothing else, and `next_run_at` is never computed. The only
  // thing that runs a schedule is `POST /schedules/:id/trigger`, called by hand
  // or by system cron — which is what `docs/platform/disaster-recovery.md` §3.1
  // documents.
  //
  // That gap matters more than it looks, because no installer closes it either:
  // `install/install.sh` writes a systemd unit for the engine and the word
  // "backup" does not appear in it at all. So a default install has no automatic
  // backups, and the screen that would suggest otherwise is this one.
  //
  // Until a scheduler exists, the honest thing is to say so rather than accept
  // a cron expression and answer 201. `nextCronRun` (lib/flows/cron.ts) and the
  // execution body of the trigger route are both already here, so the work is
  // extraction rather than invention — see the note on the create route.

  const ScheduleSchema = z.object({
    name: z.string().min(1),
    cron_expression: z.string().min(1),
    retention_count: z.number().int().min(1).default(7),
    // `s3` and `both` are refused rather than stored.
    //
    // Nothing uploads a backup anywhere: there is no S3 upload code, and
    // `zv_backup_uploads` — the table that would record one — has no reader or
    // writer in the entire repository. Accepting the setting produced a
    // configuration an operator could see in the UI, believe, and rely on for
    // off-site copies that were never made. A refusal costs a 400; the silence
    // cost the backup.
    storage_destination: z.enum(['local', 's3', 'both']).default('local'),
    s3_bucket: z.string().optional(),
    s3_prefix: z.string().optional(),
    notify_on_failure: z.boolean().default(true),
    notify_emails: z.array(z.string().email()).default([]),
    is_active: z.boolean().default(true),
  });

  /**
   * `s3` and `both` are accepted now — `lib/backup/upload.ts` implements them —
   * but only when there is somewhere to upload to.
   *
   * The check is deliberately at write time rather than at run time: a schedule
   * that will never be able to upload should be refused when it is created, not
   * discovered failing at 03:00. Zveltio's default store is `local`, and the
   * SeaweedFS in docker-compose is opt-in, so this refusal is the ordinary case
   * and says so.
   */
  async function unusableDestination(dest: string | undefined): Promise<string | null> {
    if (dest === undefined || dest === 'local') return null;
    const canUpload = (await getStorage().signedPutUrl('probe', 60)) !== null;
    if (canUpload) return null;
    return (
      `storage_destination='${dest}' needs object storage, and this instance stores ` +
      'files locally — which is the default and usually right. Configure S3_ENDPOINT ' +
      '(pointing somewhere that is NOT this machine, or the copy is not off-site), or ' +
      "keep storage_destination='local' and copy the files yourself. See " +
      'docs/platform/disaster-recovery.md §3.1.'
    );
  }

  // GET /schedules — list backup schedules
  router.get('/schedules', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const data = c.req.valid('json');

    const refusal = await unusableDestination(data.storage_destination);
    if (refusal) return c.json({ error: refusal }, 400);

    // `notify_emails` goes in as the ARRAY, not `JSON.stringify(it)`.
    //
    // The column is `text[]`, and a JSON string is not an array literal:
    // Postgres answers `malformed array literal: "[]"` — `[` must introduce
    // explicit dimensions, the literal it wants is `{}`. That is SQLSTATE 22P02,
    // which `problem.ts` renders as a 400 `invalid_parameter`, so the route
    // looked like it was rejecting the caller's input.
    //
    // It was not. EVERY payload failed, the defaults included, because
    // `.default([])` supplies the empty array that cannot be cast. This endpoint
    // has never created a schedule — `zv_backup_schedules` was empty on a
    // database where it had just been called.
    //
    // Which is also why `zv_backup_uploads` has no writer anywhere and nothing
    // reads `cron_expression`: no row ever reached them.
    const result = await sql<{ id: string }>`
      INSERT INTO zv_backup_schedules (
        name, cron_expression, retention_count, storage_destination,
        s3_bucket, s3_prefix, notify_on_failure, notify_emails,
        is_active, created_by
      ) VALUES (
        ${data.name}, ${data.cron_expression}, ${data.retention_count},
        ${data.storage_destination}, ${data.s3_bucket ?? null}, ${data.s3_prefix ?? null},
        ${data.notify_on_failure}, ${data.notify_emails},
        ${data.is_active}, ${user.id}
      ) RETURNING id::text
    `.execute(db);

    await auditLog(db, {
      type: 'backup.scheduled',
      userId: user.id,
      resourceId: result.rows[0].id,
      resourceType: 'backup_schedule',
      metadata: { name: data.name, cron: data.cron_expression, action: 'created' },
    });
    // Give it a first occurrence. A row whose `next_run_at` is NULL never
    // becomes due — which is the state every schedule ever created was in,
    // because nothing computed it.
    const firstRun = await setNextRun(db, result.rows[0].id, data.cron_expression);

    // `manual_only` is in the response because the operator cannot see it any
    // other way: the row looks exactly like a working schedule, and the audit
    // log records `backup.scheduled`, which is what an auditor would rely on.
    return c.json(
      firstRun
        ? { schedule_id: result.rows[0].id, next_run_at: firstRun.toISOString() }
        : {
            schedule_id: result.rows[0].id,
            next_run_at: null,
            warning:
              `cron_expression '${data.cron_expression}' could not be parsed, so this ` +
              'schedule will never run. Fix it with PATCH, or trigger it manually ' +
              `with POST /api/backup/schedules/${result.rows[0].id}/trigger.`,
          },
      201,
    );
  });

  // PATCH /schedules/:id — update schedule
  router.patch('/schedules/:id', zValidator('json', ScheduleSchema.partial()), async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;

    const existing = await sql<{ id: string }>`
      SELECT id::text FROM zv_backup_schedules WHERE id = ${id}
    `.execute(db);

    if (!existing.rows[0]) return c.json({ error: 'Schedule not found' }, 404);

    const refusal = await unusableDestination(data.storage_destination);
    if (refusal) return c.json({ error: refusal }, 400);

    const setClauses: string[] = ['updated_at = NOW()'];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const values: any[] = [];

    if (data.name !== undefined) {
      setClauses.push(`name = $${values.push(data.name)}`);
    }
    if (data.cron_expression !== undefined) {
      setClauses.push(`cron_expression = $${values.push(data.cron_expression)}`);
    }
    if (data.retention_count !== undefined) {
      setClauses.push(`retention_count = $${values.push(data.retention_count)}`);
    }
    if (data.storage_destination !== undefined) {
      setClauses.push(`storage_destination = $${values.push(data.storage_destination)}`);
    }
    if (data.s3_bucket !== undefined) {
      setClauses.push(`s3_bucket = $${values.push(data.s3_bucket)}`);
    }
    if (data.s3_prefix !== undefined) {
      setClauses.push(`s3_prefix = $${values.push(data.s3_prefix)}`);
    }
    if (data.notify_on_failure !== undefined) {
      setClauses.push(`notify_on_failure = $${values.push(data.notify_on_failure)}`);
    }
    if (data.notify_emails !== undefined) {
      setClauses.push(`notify_emails = $${values.push(data.notify_emails)}`);
    }
    if (data.is_active !== undefined) {
      setClauses.push(`is_active = $${values.push(data.is_active)}`);
    }

    // Use Kysely updateTable for safety
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const updateData: Record<string, any> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.cron_expression !== undefined) updateData.cron_expression = data.cron_expression;
    if (data.retention_count !== undefined) updateData.retention_count = data.retention_count;
    if (data.storage_destination !== undefined)
      updateData.storage_destination = data.storage_destination;
    if (data.s3_bucket !== undefined) updateData.s3_bucket = data.s3_bucket;
    if (data.s3_prefix !== undefined) updateData.s3_prefix = data.s3_prefix;
    if (data.notify_on_failure !== undefined) updateData.notify_on_failure = data.notify_on_failure;
    if (data.notify_emails !== undefined) updateData.notify_emails = data.notify_emails;
    if (data.is_active !== undefined) updateData.is_active = data.is_active;

    await db.updateTable('zv_backup_schedules').set(updateData).where('id', '=', id).execute();

    // A changed cron expression means a changed next occurrence. Without this
    // the row keeps the marker computed from the OLD expression, so the edit
    // appears to take effect and the schedule keeps its previous times.
    if (data.cron_expression !== undefined) {
      await setNextRun(db, id, data.cron_expression);
    }

    await auditLog(db, {
      type: 'backup.scheduled',
      userId: user?.id,
      resourceId: id,
      resourceType: 'backup_schedule',
      metadata: { action: 'updated', fields: Object.keys(data) },
    });
    return c.json({ success: true });
  });

  // DELETE /schedules/:id — delete schedule
  router.delete('/schedules/:id', async (c) => {
    const id = c.req.param('id');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    await sql`DELETE FROM zv_backup_schedules WHERE id = ${id}`.execute(db);
    await auditLog(db, {
      type: 'backup.scheduled',
      userId: user?.id,
      resourceId: id,
      resourceType: 'backup_schedule',
      metadata: { action: 'deleted' },
    });
    return c.json({ success: true });
  });

  // POST /schedules/:id/trigger — manually trigger a scheduled backup now
  router.post('/schedules/:id/trigger', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const scheduleId = c.req.param('id');

    const schedule = await sql<{
      id: string;
      name: string;
      storage_destination: 'local' | 's3' | 'both';
      s3_prefix: string | null;
    }>`
      SELECT id::text, name, storage_destination, s3_prefix
        FROM zv_backup_schedules WHERE id = ${scheduleId} AND is_active = true
    `.execute(db);

    if (!schedule.rows[0]) return c.json({ error: 'Schedule not found or inactive' }, 404);

    // The body of this used to live here, which is why the schedules feature had
    // no scheduler: there was nothing for one to call. Awaited now rather than
    // fired and forgotten, so the response says what actually happened — a
    // trigger that answers 200 and then fails silently is the shape this whole
    // area kept taking.
    const out = await runScheduledBackup(db, {
      scheduleId,
      scheduleName: schedule.rows[0].name,
      target: resolveDumpTarget(),
      actorId: user?.id ?? null,
      note: `Triggered by schedule: ${schedule.rows[0].name}`,
      // Same destination as an unattended run. A manual trigger that skipped the
      // upload would make "I tested it and it worked" mean something different
      // from what happens at 03:00.
      destination: schedule.rows[0].storage_destination,
      s3Prefix: schedule.rows[0].s3_prefix,
    });

    await auditLog(db, {
      type: 'backup.scheduled',
      userId: user?.id,
      resourceId: out.backupId,
      resourceType: 'backup',
      metadata: { action: 'manual_trigger', schedule_id: scheduleId, filename: out.filename },
    });

    if (out.status === 'failed') {
      return c.json({ backup_id: out.backupId, status: out.status, error: out.error }, 500);
    }
    return c.json({ backup_id: out.backupId, filename: out.filename, status: out.status });
  });

  // ── Enterprise: Integrity Checks ──────────────────────────────

  // GET /integrity/:id — get integrity check result for a backup
  router.get('/integrity/:id', async (c) => {
    const backupId = c.req.param('id');

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

    const backup = await sql<{ filename: string; status: string; size_bytes: string | null }>`
      SELECT filename, status, size_bytes FROM zv_backups WHERE id = ${id}
    `.execute(db);

    if (!backup.rows[0]) return c.json({ error: 'Backup not found' }, 404);

    const recorded = backup.rows[0];
    const { filename } = recorded;

    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filepath = `${BACKUP_DIR}/${filename}`;
    const bunFile = Bun.file(filepath);

    let isValid = false;
    // Stored in the legacy `checksum_md5` column. We now compute SHA-256
    // for collision resistance — MD5 is fine for accidental corruption
    // but trivially forgeable, so an attacker who could swap the backup
    // file could also forge a matching MD5. SHA-256 closes that gap.
    // Column rename is a follow-up migration; the 64-char vs 32-char
    // length disambiguates old (md5) from new (sha256) rows.
    let checksumHex: string | null = null;
    let errorMsg: string | null = null;
    let actualSize: number | null = null;

    try {
      if (!(await bunFile.exists())) {
        throw new Error('Backup file not found on disk');
      }

      actualSize = bunFile.size;

      // Hash in chunks instead of `await bunFile.arrayBuffer()`. A backup is the
      // largest file this product produces, and that line materialised it in the
      // JS heap on a request handler, then copied it again into a Buffer — two
      // full copies of the database in memory at once.
      const hasher = createHash('sha256');
      const reader = bunFile.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      checksumHex = hasher.digest('hex');

      // `isValid = true` used to sit here unconditionally, so the only thing that
      // could make it false was the file being absent or unreadable. That is not
      // an integrity check: a truncated dump, a half-written file from a crashed
      // pg_dump, or a backup quietly replaced on disk all reported
      // `is_valid: true`. This flag is the product's answer to "is my backup
      // restorable", and it was answering "did the file open".
      //
      // Three comparisons, all against what the system already recorded.
      const problems: string[] = [];

      if (recorded.status !== 'completed') {
        problems.push(`backup status is "${recorded.status}", not "completed"`);
      }

      const expectedSize = toNumberOrNull(recorded.size_bytes);
      if (expectedSize === null) {
        problems.push('no size was recorded for this backup, so it cannot be verified');
      } else if (expectedSize !== actualSize) {
        problems.push(
          `size is ${actualSize} bytes, recorded as ${expectedSize} — the file changed after it was written`,
        );
      }

      // A checksum from an earlier passing check is the strongest evidence
      // available: if it differs, the bytes changed after that check passed. The
      // first check has nothing to compare against and sets the baseline.
      const prior = await sql<{ checksum_md5: string | null }>`
        SELECT checksum_md5 FROM zv_backup_integrity_checks
        WHERE backup_id = ${id} AND is_valid = true AND checksum_md5 IS NOT NULL
        ORDER BY checked_at DESC LIMIT 1
      `.execute(db);
      const priorChecksum = prior.rows[0]?.checksum_md5 ?? null;
      // Length separates legacy MD5 rows (32 chars) from SHA-256 (64). An old
      // MD5 cannot be compared against a SHA-256 and is not a mismatch.
      if (priorChecksum && priorChecksum.length === 64 && priorChecksum !== checksumHex) {
        problems.push(
          'checksum differs from the last successful check — the file has been modified',
        );
      }

      isValid = problems.length === 0;
      if (!isValid) errorMsg = problems.join('; ');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      errorMsg = err.message;
      isValid = false;
    }

    const result = await sql<{ id: string }>`
      INSERT INTO zv_backup_integrity_checks (backup_id, filename, size_bytes, checksum_md5, is_valid, error)
      VALUES (${id}, ${filename}, ${actualSize}, ${checksumHex}, ${isValid}, ${errorMsg})
      RETURNING id::text
    `.execute(db);

    return c.json({
      check_id: result.rows[0].id,
      backup_id: id,
      filename,
      size_bytes: actualSize,
      checksum_sha256: checksumHex,
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
      total_size_bytes: toNumber(totalResult.rows[0]?.total_size, 0, 'SUM(size_bytes)'),
      total_size_human: formatBytes(totalResult.rows[0]?.total_size ?? 0),
      last_successful_backup: lastSuccessResult.rows[0] ?? null,
      success_rate_30d: successRate,
      active_schedule_count: parseInt(scheduleCountResult.rows[0]?.count || '0'),
    });
  });

  return router;
}

/**
 * A byte count as something an operator can read.
 *
 * Takes `unknown` on purpose. `zv_backups.size_bytes` is `BIGINT` and the driver
 * returns BIGINTs as strings, so the old `(bytes: number)` signature was a
 * promise the callers could not keep — and TypeScript accepted them all, because
 * the row types were hand-written as `number` too. Two ways it broke:
 *
 *     formatBytes("0")             → "NaN undefined"   (`"0" === 0` is false,
 *                                     so Math.log(0) = -Infinity, index -Infinity)
 *     formatBytes("5497558138880") → "5 undefined"     (the table stopped at GB)
 *
 * The first is reachable from an empty backup, the second from any instance over
 * a terabyte — both on a page whose whole job is reporting size.
 */
function formatBytes(bytes: unknown): string {
  const n = toNumberSafe(bytes, Number.NaN);
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Clamped: a size past the last unit used to index off the end of the array
  // and concatenate the word "undefined" into the answer.
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((n / k ** i).toFixed(2))} ${sizes[i]}`;
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

/**
 * The archive a built-in backup writes: the engine's roles, then the database
 * (ADR 0047 decision 2).
 *
 * The roles belong to the cluster, so `pg_dump` does not carry them, while it
 * does carry every GRANT that names them. Replayed onto a server where they do
 * not exist, each of those GRANTs fails and is gone for good, and migration
 * 121's marker makes the engine refuse to boot (`enforceRoleGrantsMarker`).
 * Measured 2026-11-13: a `POST /api/backup` archive restored onto a role-less
 * cluster stopped at `role "zveltio_flow_reader" does not exist` under
 * `ON_ERROR_STOP=1`, and without it booted into that refusal.
 *
 * So the archive opens with its own gzip member: `CREATE ROLE … NOLOGIN` for
 * each engine role, only where it is absent, no passwords, no grants — the
 * grants follow in the dump, the memberships the engine makes at boot. Then
 * `pg_dump` appends the dump as a second member. `gunzip -c | psql` reads both
 * in order, so the one documented restore command creates the roles first.
 * Not `pg_dumpall --roles-only`: it needs a superuser, which a managed Postgres
 * does not give.
 */

import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { DumpTarget } from './run-scheduled-backup.js';

/**
 * The roles the engine creates by a fixed name: the three migration 121's
 * marker watches (tenant-manager.ts), `zveltio_coll_exempt` (migration 058),
 * and `zveltio_ext` / `zveltio_ext_bypass` (ext-db-role.ts). Carried whenever
 * the source cluster has them, even where no grant in this database names one:
 * a function reads `zveltio_coll_exempt` by name, and nothing recreates it.
 */
const FIXED_ENGINE_ROLES = [
  'zveltio_rls',
  'zveltio_worker',
  'zveltio_flow_reader',
  'zveltio_coll_exempt',
  'zveltio_ext',
  'zveltio_ext_bypass',
];

/**
 * The SQL that creates every engine role this database depends on, or '' when
 * there is none (a managed Postgres where the engine could create no roles).
 *
 * Which roles: the fixed ones above, and every other `zveltio_` NOLOGIN role an
 * object in THIS database depends on (`pg_shdepend`: grants, default
 * privileges, policies, ownership) — the per-extension `zveltio_ext_*`,
 * `zveltio_extb_*` and `zveltio_wrk_*`. Not every `zveltio_` role in the
 * cluster: one cluster can hold many databases, each with its own extension
 * roles. Login roles never: they carry passwords, and the operator creates the
 * one the engine connects as.
 */
export async function engineRolesSql(db: Database): Promise<string> {
  const r = await sql<{ name: string; bypass: boolean }>`
    SELECT rolname AS name, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles
     WHERE rolname ~ '^zveltio_[a-z0-9_]+$' AND NOT rolcanlogin
       AND (rolname = ANY(${FIXED_ENGINE_ROLES}::text[])
            OR oid IN (SELECT refobjid FROM pg_catalog.pg_shdepend
                        WHERE refclassid = 'pg_catalog.pg_authid'::regclass
                          AND dbid = (SELECT oid FROM pg_catalog.pg_database
                                       WHERE datname = current_database())))
     ORDER BY rolname
  `.execute(db);
  if (!r.rows.length) return '';
  // The names are `[a-z0-9_]` (the WHERE above), so they are safe inline.
  const body = r.rows
    .map(
      ({ name, bypass }) =>
        `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${name}') THEN\n` +
        `    CREATE ROLE ${name} NOLOGIN NOSUPERUSER ${bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOCREATEDB NOCREATEROLE;\n` +
        '  END IF;\n',
    )
    .join('');
  return (
    '-- Zveltio engine roles (ADR 0047). pg_dump does not carry roles, and the dump\n' +
    '-- below grants to these: each is created first, only where it is absent.\n' +
    '-- NOLOGIN, no password, no grant: the grants are in the dump, and the engine\n' +
    '-- makes the memberships when it boots.\n' +
    `DO $zveltio_engine_roles$\nBEGIN\n${body}END\n$zveltio_engine_roles$;\n\n`
  );
}

/**
 * Write the archive to `filepath`: the roles member, then `pg_dump`'s own
 * gzip output appended to the same file descriptor — no pipe through this
 * process, so a write that fails (disk full, SIGXFSZ) is `pg_dump`'s exit code.
 *
 * `rolesBytes` is the size of the roles member, which `verifyArchive` subtracts:
 * a dump of nothing behind it is still a dump of nothing. A dump that failed
 * leaves no file: the roles member alone would look like a partial backup.
 */
export async function writeBackupArchive(
  db: Database,
  target: DumpTarget,
  filepath: string,
): Promise<{ exitCode: number; stderr: string; rolesBytes: number }> {
  const roles = await engineRolesSql(db);
  const head = roles ? gzipSync(roles) : null;
  const fd = openSync(filepath, 'w', 0o600);
  let ok = false;
  try {
    if (head) writeSync(fd, head);
    const proc = Bun.spawn(
      [
        'pg_dump',
        '-h',
        target.host,
        '-p',
        String(target.port),
        '-U',
        target.user,
        '-d',
        target.name,
        '-Z',
        '6',
      ],
      {
        env: { ...process.env, PGPASSWORD: target.password } as Record<string, string>,
        stdout: fd,
        stderr: 'pipe',
      },
    );
    await proc.exited;
    const exitCode = proc.exitCode ?? 1;
    ok = exitCode === 0;
    const stderr = ok ? '' : await new Response(proc.stderr).text();
    return { exitCode, stderr, rolesBytes: head?.length ?? 0 };
  } finally {
    closeSync(fd);
    if (!ok) rmSync(filepath, { force: true });
  }
}

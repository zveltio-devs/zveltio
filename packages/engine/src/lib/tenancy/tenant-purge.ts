/**
 * Purging a tenant: every row it owns, in one transaction, then the tenant row.
 *
 * Collection tables carry `tenant_id` with no foreign key to `zv_tenants`, so a
 * bare `DELETE FROM zv_tenants` leaves their rows behind, invisible to every
 * tenant and in the way of the next Ghost DDL swap (#750). The tables are found
 * by the column rather than listed, because extensions and collections add them
 * at run time.
 *
 * Covered: every base table in `public` with a `tenant_id` column of a uuid or
 * text type — engine `zv_*`, extension tables, managed `zvd_*` collections, and
 * BYOD (`is_managed = false`) tables in `public` that chose a `tenant_id`
 * column, since the engine writes that column the same way there. Not covered:
 * tables outside `public` (a BYOD table in another schema is somebody else's
 * data model) and `_zv_*` Ghost DDL work tables, whose rows follow the original
 * table through the migration's own changelog. Junction and child tables with
 * no `tenant_id` go with their parents through their ON DELETE CASCADE keys.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withSavepoint } from '../savepoint.js';
import { getCurrentTenantTrx } from './tenant-context.js';
import { DEFAULT_TENANT_ID, getTenantSchemaName, publishEveryTenant } from './tenant-manager.js';

export class TenantPurgeRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface TenantPurgeResult {
  tenant: { id: string; slug: string };
  /** Rows deleted per table, tables with none left out. */
  deleted: Record<string, number>;
  /** Object keys of the tenant's media, for the caller to remove AFTER commit. */
  storagePaths: string[];
  /** Users who held a membership, for cache and Casbin cleanup after commit. */
  memberIds: string[];
  droppedSchemas: string[];
}

const count = async (trx: Database, q: ReturnType<typeof sql>) =>
  (
    await sql<{ n: number }>`WITH d AS (${q} RETURNING 1) SELECT count(*)::int AS n FROM d`.execute(
      trx,
    )
  ).rows[0]?.n ?? 0;

export async function purgeTenant(
  db: Database,
  tenantId: string,
  confirmSlug: string | undefined,
): Promise<TenantPurgeResult> {
  if (tenantId === DEFAULT_TENANT_ID) {
    throw new TenantPurgeRefused('The default tenant cannot be purged.', 409);
  }
  // The purge must OWN its transaction. Joined to a request's (the proxy's
  // `transaction()` joins rather than nests), its `set_config(…, true)` — every
  // tenant's reach, `rls_bypass=on` — would stay in force for the rest of that
  // request, and the media objects the caller deletes on return would go while
  // the rows naming them could still roll back. `/api/tenants` is in the tenant
  // middleware's TXN_SKIP_PREFIXES; this keeps it from depending on that list.
  if (getCurrentTenantTrx()) {
    throw new Error('purgeTenant must not run inside a request transaction');
  }
  return db.transaction().execute(async (trx) => {
    // FOR UPDATE: a concurrent reactivation or a new child tenant (its FK takes
    // KEY SHARE on this row) waits for us, so the checks below stay true.
    const tenant = (
      await sql<{ id: string; slug: string; status: string }>`
        SELECT id::text AS id, slug, status FROM zv_tenants WHERE id = ${tenantId} FOR UPDATE
      `.execute(trx)
    ).rows[0];
    if (!tenant) throw new TenantPurgeRefused('Tenant not found', 404);
    if (tenant.status !== 'deleted') {
      throw new TenantPurgeRefused(
        `Tenant "${tenant.slug}" is ${tenant.status}. Archive it first (mode: archive), then purge.`,
        409,
      );
    }
    if (confirmSlug !== tenant.slug) {
      throw new TenantPurgeRefused(
        `confirm must equal the tenant's slug ("${tenant.slug}") to purge it.`,
        400,
      );
    }
    const dependants = await sql<{ slug: string }>`
      SELECT slug FROM zv_tenants WHERE parent_id = ${tenantId} OR merged_into = ${tenantId}
      ORDER BY slug
    `.execute(trx);
    if (dependants.rows.length) {
      throw new TenantPurgeRefused(
        `Tenant "${tenant.slug}" still has child tenants (${dependants.rows.map((r) => r.slug).join(', ')}). ` +
          'Purge them or move them to another parent first — whatever their status.',
        409,
      );
    }

    // Stay the table owner, but read every tenant: FORCE RLS binds a
    // non-superuser owner, and with no set published the pool sees only the
    // default tenant — the target's rows would be invisible to the DELETE and
    // it would report zero. Every tenant, not just the target, so the reference
    // check below can see the rows that point in from outside. Row rules stand
    // down: this is not a request made on anyone's behalf.
    await publishEveryTenant(trx);
    await sql`
      SELECT set_config('zveltio.current_tenant', ${tenantId}, true),
             set_config('zveltio.actor', 'off', true),
             set_config('zveltio.rls_bypass', 'on', true)
    `.execute(trx);

    const tables = (
      await sql<{ name: string }>`
        SELECT c.relname AS name
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
           AND c.relname NOT LIKE '\\_zv\\_%'
           AND a.attname = 'tenant_id' AND NOT a.attisdropped
           AND a.atttypid IN ('uuid'::regtype, 'text'::regtype, 'varchar'::regtype)
         ORDER BY c.relname
      `.execute(trx)
    ).rows.map((r) => r.name);

    // A cascade must never reach another tenant. A row of tenant B pointing at
    // one of ours — a parent reading its subtree can create exactly that — would
    // be deleted or nulled by the key's ON DELETE, bypassing RLS. Refused
    // instead, naming where.
    const fks = await sql<{ src: string; col: string; dst: string; dcol: string }>`
      SELECT s.relname AS src, a.attname AS col, d.relname AS dst, da.attname AS dcol
        FROM pg_constraint k
        JOIN pg_class s ON s.oid = k.conrelid
        JOIN pg_class d ON d.oid = k.confrelid
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        JOIN pg_attribute da ON da.attrelid = k.confrelid AND da.attnum = k.confkey[1]
        JOIN pg_namespace sn ON sn.oid = s.relnamespace AND sn.nspname = 'public'
        JOIN pg_namespace dn ON dn.oid = d.relnamespace AND dn.nspname = 'public'
       WHERE k.contype = 'f' AND cardinality(k.conkey) = 1
         AND s.relname = ANY (${tables}) AND d.relname = ANY (${tables})
    `.execute(trx);
    for (const fk of fks.rows) {
      const hit = await sql<{ n: number }>`
        SELECT count(*)::int AS n
          FROM ${sql.id('public', fk.src)} r JOIN ${sql.id('public', fk.dst)} t ON r.${sql.id(fk.col)} = t.${sql.id(fk.dcol)}
         WHERE t.tenant_id = ${tenantId} AND r.tenant_id::text <> ${tenantId}
      `.execute(trx);
      const n = hit.rows[0]?.n ?? 0;
      if (n > 0) {
        throw new TenantPurgeRefused(
          `${n} row(s) of other tenants in ${fk.src}.${fk.col} reference this tenant's rows in ` +
            `${fk.dst}. Remove or repoint them first; purging would delete or change them.`,
          409,
        );
      }
    }

    // Read before the rows go. A key another tenant's row also names is kept.
    const paths = await sql<{ p: string }>`
      SELECT DISTINCT p FROM (
        SELECT f.storage_path AS p FROM zv_media_files f WHERE f.tenant_id = ${tenantId}
        UNION ALL
        SELECT v.storage_path FROM zv_media_versions v
          JOIN zv_media_files f ON f.id = v.file_id WHERE f.tenant_id = ${tenantId}
      ) x
      WHERE p IS NOT NULL AND p <> ''
        AND NOT EXISTS (SELECT 1 FROM zv_media_files o
                         WHERE o.storage_path = x.p AND o.tenant_id <> ${tenantId})
    `.execute(trx);
    // Every row, lapsed included: a former member is this tenant's to clean up.
    const members = await sql<{ id: string }>`
      SELECT user_id AS id FROM zv_tenant_users WHERE tenant_id = ${tenantId}
    `.execute(trx);

    // Per-tenant Postgres schemas: the environments', and the legacy base one
    // tenant creation no longer makes. The base name of tenant `acme-dev` is
    // spelled like the `dev` environment schema of tenant `acme`, so a schema
    // another tenant's environment names, or another tenant's base name spells,
    // is left alone — in both directions.
    const othersBase = new Set(
      (
        await sql<{ slug: string }>`SELECT slug FROM zv_tenants WHERE id <> ${tenantId}`.execute(
          trx,
        )
      ).rows.map((r) => getTenantSchemaName(r.slug)),
    );
    const found = await sql<{ s: string }>`
      SELECT s FROM (
        SELECT schema_name AS s FROM zv_environments WHERE tenant_id = ${tenantId}
        UNION SELECT ${getTenantSchemaName(tenant.slug)}
      ) x
      WHERE s LIKE 'tenant\\_%'
        AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = x.s)
        AND NOT EXISTS (SELECT 1 FROM zv_environments e
                         WHERE e.schema_name = x.s AND e.tenant_id <> ${tenantId})
    `.execute(trx);
    const schemas = found.rows.map((r) => r.s).filter((s) => !othersBase.has(s));

    // Foreign keys between our own tables decide the order, and they are not
    // known up front: a table refused with 23503 is retried after the others.
    // A delete can also write — the sync trigger (#739) leaves a tombstone per
    // collection row in a table this loop may already have emptied — so passes
    // repeat until one deletes nothing.
    const deleted: Record<string, number> = {};
    for (let pass = 0, removed = 1; removed > 0; pass++) {
      if (pass === 5) {
        throw new TenantPurgeRefused(
          'Rows for this tenant keep reappearing as they are deleted (a trigger?). Nothing was deleted.',
          409,
        );
      }
      removed = 0;
      let pending = tables;
      while (pending.length) {
        const blocked: string[] = [];
        let lastError = '';
        for (const table of pending) {
          const n = await withSavepoint(
            trx,
            'zv_tenant_purge',
            () =>
              count(trx, sql`DELETE FROM ${sql.id('public', table)} WHERE tenant_id = ${tenantId}`),
            (err) => {
              if (String((err as { errno?: unknown }).errno) !== '23503') throw err;
              lastError = (err as Error).message;
              return -1;
            },
          );
          if (n < 0) blocked.push(table);
          else if (n > 0) {
            deleted[table] = (deleted[table] ?? 0) + n;
            removed += n;
          }
        }
        if (blocked.length === pending.length) {
          throw new TenantPurgeRefused(
            `Could not purge ${blocked.join(', ')}: ${lastError}. Nothing was deleted.`,
            409,
          );
        }
        pending = blocked;
      }
    }

    const transfers = await count(
      trx,
      sql`DELETE FROM zv_tenant_transfers WHERE from_tenant = ${tenantId} OR to_tenant = ${tenantId}`,
    );
    if (transfers) deleted.zv_tenant_transfers = transfers;
    for (const s of schemas) {
      await sql`DROP SCHEMA IF EXISTS ${sql.id(s)} CASCADE`.execute(trx);
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${tenantId}`.execute(trx);

    return {
      tenant: { id: tenant.id, slug: tenant.slug },
      deleted,
      storagePaths: paths.rows.map((r) => r.p),
      memberIds: members.rows.map((r) => r.id),
      droppedSchemas: schemas,
    };
  });
}

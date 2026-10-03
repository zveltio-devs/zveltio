/**
 * Read-only facts about the running tenant that extensions used to compute with
 * raw SQL on engine tables (`"user"`, `zv_tenant_users`, `zv_tenants`,
 * `zv_settings`, `pg_class`, `zvd_permissions`) — refused since #858.
 *
 * Each answer is scoped by the ENGINE to the tenant the work runs as (the
 * domain in the async context), never by an argument, so an extension cannot
 * ask about a tenant it is not serving. On a multi-tenant instance a number
 * that can only be computed instance-wide (the planner's row estimate) is
 * `null`, not another customer's total.
 */
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import { auditLog } from '../audit.js';
import type { AuditEventType } from '../audit.js';
import { DDLManager } from '../data/index.js';
import {
  activeMembership,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  getEnforcer,
  withTenantIsolation,
} from '../tenancy/index.js';

function runningTenant(helper: string): string {
  const tenant = getCurrentDomainOrNull();
  if (!tenant) throw new Error(`ctx.internals.${helper}: no tenant runs here`);
  return tenant;
}

/**
 * True when the instance holds one tenant. Then "the tenant" and "the
 * instance" are the same people, and a single-tenant install needs no
 * membership rows — so its headcount is the `user` table.
 */
async function instanceIsSingleTenant(db: Database): Promise<boolean> {
  const r = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM zv_tenants`.execute(db);
  return (r.rows[0]?.n ?? 0) <= 1;
}

export interface MemberCounts {
  /** People with a membership in force in the running tenant. */
  total: number;
  /** Of those, the tenant's owners and admins. */
  admins: number;
}

export async function countMembers(db: Database = getDb()): Promise<MemberCounts> {
  const tenant = runningTenant('countMembers');
  if (await instanceIsSingleTenant(db)) {
    const r = await sql<{ total: number; admins: number }>`
      SELECT COUNT(*)::int AS total,
             (COUNT(*) FILTER (WHERE role IN ('god', 'admin')))::int AS admins
        FROM "user"
    `.execute(db);
    return { total: r.rows[0]?.total ?? 0, admins: r.rows[0]?.admins ?? 0 };
  }
  const r = await sql<{ total: number; admins: number }>`
    SELECT COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE role IN ('owner', 'admin')))::int AS admins
      FROM zv_tenant_users
     WHERE tenant_id = ${tenant}::uuid AND ${activeMembership()}
  `.execute(db);
  return { total: r.rows[0]?.total ?? 0, admins: r.rows[0]?.admins ?? 0 };
}

export interface DataStats {
  /** Registered collections. */
  collections: number;
  /**
   * Planner estimate of rows across collection tables. `null` on a
   * multi-tenant instance: the estimate counts every tenant's rows.
   */
  records_estimate: number | null;
}

export async function getDataStats(db: Database = getDb()): Promise<DataStats> {
  runningTenant('getDataStats');
  const collections = (await DDLManager.getCollections(db)).length;
  if (!(await instanceIsSingleTenant(db))) return { collections, records_estimate: null };
  const r = await sql<{ n: string }>`
    SELECT COALESCE(SUM(GREATEST(reltuples, 0)), 0)::bigint AS n
      FROM pg_class WHERE relkind = 'r' AND relname LIKE 'zvd\\_%'
  `.execute(db);
  return { collections, records_estimate: Number(r.rows[0]?.n ?? 0) };
}

/**
 * Role names in force in the running tenant: grants made in it or in every
 * tenant (`'*'`), plus the `"user".role` column roles. `listAllRoles()` reads
 * every tenant's grants, which names another customer's custom roles.
 */
export async function listRoles(): Promise<string[]> {
  const tenant = runningTenant('listRoles');
  const e = await getEnforcer();
  const set = new Set<string>(['god', 'member']);
  for (const row of ((await e.getNamedGroupingPolicy('g')) ?? []) as string[][]) {
    const [, role, domain] = row;
    if (role && (domain === tenant || domain === '*' || domain === undefined)) set.add(role);
  }
  return [...set].sort();
}

/**
 * A setting the instance publishes (`is_public`). Non-public settings hold
 * credentials (SMTP, storage, AI keys) and stay engine-only.
 */
export async function getPublicSetting(key: string, db: Database = getDb()): Promise<unknown> {
  const r = await sql<{ value: unknown }>`
    SELECT value FROM zv_settings WHERE key = ${key} AND is_public = true
  `.execute(db);
  if (r.rows.length === 0) return null;
  const raw = r.rows[0]?.value;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface ExtensionAuditEvent {
  type: string;
  userId?: string;
  resourceId?: string;
  resourceType?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Write an audit row for an extension. `metadata.extension` is the engine's
 * record of who wrote it — set after the caller's metadata, so an extension
 * cannot write a row that reads as another's (or as the engine's own).
 *
 * The row belongs to the running tenant, written in a transaction of its own
 * for it (the policy admits a tenant row only from that tenant's transaction),
 * and not in the caller's: a failed audit write must not abort the request.
 * Where no tenant runs it is an instance-level row.
 */
export function auditAs(caller: string, event: ExtensionAuditEvent): Promise<void> {
  if (typeof event?.type !== 'string' || event.type.length === 0 || event.type.length > 100) {
    return Promise.reject(new Error('ctx.internals.audit: event.type must be a 1-100 char string'));
  }
  const row = {
    ...event,
    type: event.type as AuditEventType,
    metadata: { ...(event.metadata ?? {}), extension: caller },
  };
  const tenant = getCurrentDomainOrNull();
  return tenant ? withTenantIsolation(tenant, (trx) => auditLog(trx, row)) : auditLog(getDb(), row);
}

export interface AuditActivity {
  id: string;
  event_type: string;
  user_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: Date;
}

export interface AuditActivityQuery {
  /** At most 100; 20 when absent. */
  limit?: number;
  eventType?: string;
  resourceType?: string;
  /** Only rows at or after this instant. */
  since?: Date | string;
}

const AUDIT_ACTIVITY_MAX = 100;

/**
 * The running tenant's recent audit rows, newest first. No `metadata` and no
 * `ip`: those carry what the writer chose to record, which is not this
 * extension's to read.
 *
 * Read inside a tenant transaction — the caller's, or one opened for the
 * running tenant — so the policy binds on a plain-role install, where the pool
 * would see the default firm only. The explicit `tenant_id` filter narrows a
 * wider reach (god's, a subtree's) to the running tenant, and keeps out the
 * instance-level rows a superuser connection would otherwise return.
 */
export async function readAuditActivity(query: AuditActivityQuery = {}): Promise<AuditActivity[]> {
  const tenant = runningTenant('readAuditActivity');
  const limit = Math.min(
    Math.max(Math.trunc(Number(query.limit ?? 20)) || 1, 1),
    AUDIT_ACTIVITY_MAX,
  );
  const since = query.since === undefined ? undefined : new Date(query.since);
  if (since && Number.isNaN(since.getTime())) {
    throw new Error('ctx.internals.readAuditActivity: since is not a date');
  }
  const read = (trx: Database) => {
    let q = trx
      .selectFrom('zv_audit_log')
      .select(['id', 'event_type', 'user_id', 'resource_type', 'resource_id', 'created_at'])
      .where('tenant_id', '=', tenant)
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (query.eventType) q = q.where('event_type', '=', query.eventType);
    if (query.resourceType) q = q.where('resource_type', '=', query.resourceType);
    if (since) q = q.where('created_at', '>=', since);
    return q.execute();
  };
  const trx = getCurrentTenantTrx();
  return trx ? read(trx) : withTenantIsolation(tenant, read);
}

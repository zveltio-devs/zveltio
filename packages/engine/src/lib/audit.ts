import { sql } from 'kysely';
import { type Database, getDb } from '../db/index.js';
import { getCurrentTenantTrx, onAfterCommit, withTenantIsolation } from './tenancy/index.js';

export type AuditEventType =
  | 'auth.login_failed'
  | 'auth.login_success'
  | 'auth.logout'
  | 'permission.denied'
  | 'permission.granted'
  | 'permission.revoked'
  | 'collection.created'
  | 'collection.deleted'
  | 'schema.applied'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'user.role_changed'
  | 'user.invited'
  | 'user.deleted'
  | 'user.created'
  | 'user.profile_updated'
  | 'settings.changed'
  | 'god_mode.used'
  | 'extension.loaded'
  | 'extension.load_failed'
  | 'extension.unloaded'
  /** An administrator granted an extension the capabilities its manifest
   * declares. The one place a privilege widening is a deliberate act. */
  | 'extension.capabilities.approved'
  // An anonymous execution of a public edge function. Its own type because the
  // authenticated invocations are attributable by their user and these are not
  // attributable by anything but time and address.
  | 'edge_function.invoked_anonymously'
  | 'sql.executed'
  // Its own event, not a field on `sql.executed`. Someone asking who changed
  // the data should be able to filter for it, rather than read every ad-hoc
  // SELECT anyone has ever run looking for the one that wrote.
  | 'sql.write.executed'
  | 'sql.failed'
  | 'backup.created'
  | 'backup.deleted'
  | 'backup.downloaded'
  | 'backup.restored'
  | 'backup.scheduled'
  | 'pitr.config_changed'
  | 'pitr.restored'
  | 'approval.workflow_changed'
  | 'approval.decided'
  | 'approval.submitted'
  | 'approval.cancelled'
  | 'api_key.rate_limit_set'
  | 'api_key.rate_limit_removed'
  | 'export.executed'
  // Tenant lifecycle and membership.
  //
  // `routes/tenants.ts` held no audit call at all: creating a firm, suspending
  // one, granting somebody `tenant_owner` inside it and taking it away again all
  // happened with no trace, while `routes/permissions.ts` audited the same act —
  // granting a role — on its own endpoint. One act, two routes, one of them
  // invisible.
  //
  // Their own types rather than folding them into `permission.granted`: someone
  // asking who was given the run of a firm should be able to filter for that,
  // not read every permission event ever written looking for the ones that were
  // about membership.
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.member_added'
  | 'tenant.member_removed'
  | 'tenant.member_updated'
  | 'tenant.rls_enabled'
  | 'tenant.archived'
  | 'tenant.purged'
  // One row per request by a god (`middleware/god-audit.ts`).
  | 'god_action';

export interface AuditEvent {
  type: AuditEventType;
  userId?: string;
  resourceId?: string;
  resourceType?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  metadata?: Record<string, any>;
  ip?: string;
  /**
   * Whose activity this is (`zv_audit_log.tenant_id`, migration 040).
   *
   * Absent: the writing transaction's tenant, NULL outside one. A tenant id:
   * that tenant's row, so it shows in the tenant's own activity — needed where
   * the route acts on a tenant it does not run as (`/api/tenants` runs in none).
   * `null`: an instance-level event, which a request's tenant transaction would
   * otherwise hand to whichever tenant the request resolved (the default firm,
   * on the root host).
   */
  tenantId?: string | null;
}

/**
 * Audit writes still running.
 *
 * Most callers do not await `auditLog` — the route answers the request and lets
 * the row land behind it, which is right: an audit failure must not break the
 * flow it is recording. It leaves a test with nothing to await, and
 * `sql-editor-read-only.test.ts` had the consequence: one case performs a write
 * over HTTP and the NEXT case reads `zv_audit_log` for the event it produced.
 * That passed on an idle runner and failed on a busy one, which is the worst
 * kind of red — it looks like the feature broke.
 *
 * Same answer as `_settleWebhookDeliveries` in `lib/webhooks.ts`: let a test
 * await the work instead of guessing how long it takes.
 */
const _inFlight = new Set<Promise<unknown>>();

/** Resolve once every audit write started so far has finished. Test-only. */
export async function _settleAuditWrites(): Promise<void> {
  // A loop rather than one `Promise.all`: a write can start another, and
  // awaiting the first snapshot would return with the second still running.
  while (_inFlight.size > 0) {
    await Promise.all([..._inFlight]);
  }
}

export async function auditLog(db: Database, event: AuditEvent): Promise<void> {
  const write = writeAuditRow(db, event);
  _inFlight.add(write);
  try {
    await write;
  } finally {
    _inFlight.delete(write);
  }
}

const CURRENT_TENANT = sql`NULLIF(current_setting('zveltio.current_tenant', true), '')`;

/**
 * One INSERT … SELECT, so a row the policy would refuse is not attempted: a
 * named tenant only from that tenant's transaction, an instance row only from
 * outside every tenant's. A refused INSERT would abort the caller's transaction
 * (25P02) on a plain-role install; no row is a decision the caller can act on.
 */
async function insertRow(db: Database, event: AuditEvent): Promise<boolean> {
  const { tenantId } = event;
  const tenant =
    tenantId === undefined ? sql`${CURRENT_TENANT}::uuid` : sql`${tenantId ?? null}::uuid`;
  const where =
    tenantId === undefined
      ? sql`true`
      : tenantId === null
        ? sql`${CURRENT_TENANT} IS NULL`
        : sql`${CURRENT_TENANT} = ${tenantId}`;
  // `::text::jsonb` on the metadata, not `::jsonb`. The driver already sends
  // that parameter as jsonb, so a bare `::jsonb` is a no-op and Postgres
  // stores the serialized string AS a jsonb string scalar — the whole object
  // wrapped in quotes with its own quotes escaped. Every row written that way
  // answers NULL to `metadata->>'anything'`, so the audit trail could be read
  // by a human and queried by nobody: no filtering by outcome, no counting
  // failed attempts, no alerting. Going through text makes Postgres parse it.
  // Migration 041 repairs the rows already written.
  const r = await sql`
    INSERT INTO zv_audit_log (
      event_type, user_id, resource_id, resource_type, metadata, ip, created_at, tenant_id
    )
    SELECT
      ${event.type},
      ${event.userId ?? null},
      ${event.resourceId ?? null},
      ${event.resourceType ?? null},
      ${JSON.stringify(event.metadata ?? {})}::text::jsonb,
      ${event.ip ?? null},
      NOW(),
      ${tenant}
    WHERE ${where}
  `.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}

async function writeAuditRow(db: Database, event: AuditEvent): Promise<void> {
  try {
    if ((await insertRow(db, event)) || event.tenantId === undefined) return;
    // Not this transaction's row to write. Inside a tenant transaction, after it
    // ends: a second connection taken while this one is held is how the engine
    // deadlocks at `c = DB_POOL_MAX`. A rollback drops it with the act it records.
    if (getCurrentTenantTrx()) {
      onAfterCommit(() => auditLog(getDb(), event));
    } else if (event.tenantId) {
      const tenantId = event.tenantId;
      await withTenantIsolation(tenantId, async (trx) => {
        if (!(await insertRow(trx, event))) throw new Error(`not written for ${tenantId}`);
      });
    } else {
      throw new Error('an instance-level row cannot be written inside a tenant transaction');
    }
  } catch (err) {
    // Audit log failure must never break the main request flow
    console.error(
      '[Audit] Failed to write audit event:',
      event.type,
      (err as Error)?.message ?? err,
    );
  }
}

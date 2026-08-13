import { sql } from 'kysely';
import type { Database } from '../db/index.js';

export type AuditEventType =
  | 'auth.login_failed'
  | 'auth.login_success'
  | 'auth.logout'
  | 'permission.denied'
  | 'permission.granted'
  | 'permission.revoked'
  | 'collection.created'
  | 'collection.deleted'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'user.role_changed'
  | 'user.invited'
  | 'user.deleted'
  | 'settings.changed'
  | 'god_mode.used'
  | 'extension.loaded'
  | 'extension.load_failed'
  | 'extension.unloaded'
  /** An administrator granted an extension the capabilities its manifest
   * declares. The one place a privilege widening is a deliberate act. */
  | 'extension.capabilities.approved'
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
  | 'export.executed';

export interface AuditEvent {
  type: AuditEventType;
  userId?: string;
  resourceId?: string;
  resourceType?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  metadata?: Record<string, any>;
  ip?: string;
}

export async function auditLog(db: Database, event: AuditEvent): Promise<void> {
  try {
    // `::text::jsonb` on the metadata, not `::jsonb`. The driver already sends
    // that parameter as jsonb, so a bare `::jsonb` is a no-op and Postgres
    // stores the serialized string AS a jsonb string scalar — the whole object
    // wrapped in quotes with its own quotes escaped. Every row written that way
    // answers NULL to `metadata->>'anything'`, so the audit trail could be read
    // by a human and queried by nobody: no filtering by outcome, no counting
    // failed attempts, no alerting. Going through text makes Postgres parse it.
    // Migration 041 repairs the rows already written.
    await sql`
      INSERT INTO zv_audit_log (
        event_type, user_id, resource_id, resource_type, metadata, ip, created_at
      ) VALUES (
        ${event.type},
        ${event.userId ?? null},
        ${event.resourceId ?? null},
        ${event.resourceType ?? null},
        ${JSON.stringify(event.metadata ?? {})}::text::jsonb,
        ${event.ip ?? null},
        NOW()
      )
    `.execute(db);
  } catch (err) {
    // Audit log failure must never break the main request flow
    console.error(
      '[Audit] Failed to write audit event:',
      event.type,
      (err as Error)?.message ?? err,
    );
  }
}

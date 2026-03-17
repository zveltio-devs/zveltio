import { sql } from 'kysely';
import type { Database } from '../db/index.js';

export type AuditEventType =
  | 'auth.login_failed'
  | 'auth.login_success'
  | 'auth.logout'
  | 'permission.denied'
  | 'collection.created'
  | 'collection.deleted'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'user.role_changed'
  | 'settings.changed'
  | 'god_mode.used';

export interface AuditEvent {
  type: AuditEventType;
  userId?: string;
  resourceId?: string;
  resourceType?: string;
  metadata?: Record<string, any>;
  ip?: string;
}

export async function auditLog(db: Database, event: AuditEvent): Promise<void> {
  try {
    await sql`
      INSERT INTO zv_audit_log (
        event_type, user_id, resource_id, resource_type, metadata, ip, created_at
      ) VALUES (
        ${event.type},
        ${event.userId ?? null},
        ${event.resourceId ?? null},
        ${event.resourceType ?? null},
        ${JSON.stringify(event.metadata ?? {})}::jsonb,
        ${event.ip ?? null},
        NOW()
      )
    `.execute(db);
  } catch {
    // Audit log failure must never break the main request flow
    console.error('[Audit] Failed to write audit event:', event.type);
  }
}

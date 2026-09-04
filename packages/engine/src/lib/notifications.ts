/**
 * In-app notification helper
 * Inserts records into zv_notifications (migration 007_notifications.sql)
 */

import { toJsonb } from './jsonb.js';

export interface NotificationInput {
  user_id: string;
  title: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  action_url?: string;
  source?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  metadata?: Record<string, any>;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export async function sendNotification(db: any, input: NotificationInput): Promise<void> {
  await db
    .insertInto('zv_notifications')
    .values({
      user_id: input.user_id,
      title: input.title,
      message: input.message,
      type: input.type ?? 'info',
      action_url: input.action_url ?? null,
      source: input.source ?? null,
      // `toJsonb`, not `JSON.stringify` — and not `'{}'` for the empty case,
      // which had the same defect: the driver JSON-encodes that string too, so
      // the "empty" metadata arrived as the jsonb STRING "{}" rather than as an
      // empty object.
      //
      // Migration 010 lists this column as double-encoded in 22 of 22 rows and
      // says of the family: "The writers are fixed in the same change, through
      // lib/jsonb.ts. The order matters: repairing the data first would leave new
      // rows arriving in the old shape." This writer was missed, so the data
      // repair was undone by the next notification. Unlike `zv_api_keys.scopes`,
      // this column has no reader-side compensation — 010 says so explicitly — so
      // every `metadata.someKey` lookup on a repaired row was undefined again.
      //
      // Found on 2026-09-04 by widening `check-jsonb-binding` to see a
      // `JSON.stringify` behind a ternary, which is the shape this line is.
      metadata: toJsonb(input.metadata ?? {}),
      is_read: false,
      created_at: new Date(),
    })
    .execute();
}

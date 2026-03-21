/**
 * In-app notification helper
 * Inserts records into zv_notifications (migration 007_notifications.sql)
 */

export interface NotificationInput {
  user_id: string;
  title: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  action_url?: string;
  source?: string;
  metadata?: Record<string, any>;
}

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
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
      is_read: false,
      created_at: new Date(),
    })
    .execute();
}

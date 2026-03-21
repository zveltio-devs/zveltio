import type { Database } from '../../../../packages/engine/src/db/index.js';

let _db: Database | null = null;

export const UsageTracker = {
  init(db: Database): void {
    _db = db;
  },

  track(
    event_type: string,
    opts?: {
      tenant_id?: string;
      collection?: string;
      quantity?: number;
      metadata?: Record<string, unknown>;
    },
  ): void {
    if (!_db) return;
    const db = _db;
    // Fire-and-forget
    (db as any)
      .insertInto('zv_usage_events')
      .values({
        event_type,
        tenant_id: opts?.tenant_id ?? null,
        collection: opts?.collection ?? null,
        quantity: opts?.quantity ?? 1,
        metadata: JSON.stringify(opts?.metadata ?? {}),
      })
      .execute()
      .catch((err: unknown) => {
        console.error('[UsageTracker] Failed to track event:', err);
      });
  },

  async getSummary(
    tenant_id: string,
    since: Date,
  ): Promise<Array<{ event_type: string; total: number }>> {
    if (!_db) return [];
    const rows = await (_db as any)
      .selectFrom('zv_usage_events')
      .select([
        'event_type',
        (eb: any) => eb.fn.sum('quantity').as('total'),
      ])
      .where('tenant_id', '=', tenant_id)
      .where('created_at', '>=', since)
      .groupBy('event_type')
      .execute();
    return rows.map((r: any) => ({ event_type: r.event_type, total: Number(r.total) }));
  },
};

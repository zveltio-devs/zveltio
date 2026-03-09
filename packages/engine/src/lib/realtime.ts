import { broadcastEvent } from '../routes/ws.js';

/**
 * RealtimeManager — PostgreSQL LISTEN/NOTIFY bridge pentru realtime multi-instanță.
 *
 * Folosește Bun.SQL.subscribe() (Bun 1.2+) în loc de pg.Client pentru LISTEN,
 * eliminând dependința de `pg` și beneficiind de I/O nativ Bun.
 *
 * Flux:
 *   Instance A: data.ts PATCH → pg_notify('zveltio_changes', payload)
 *   Instance B: RealtimeManager subscribe → primește payload → broadcastEvent()
 */
export class RealtimeManager {
  // @ts-expect-error — BunSubscription tipat de bun-types
  private subscription: import('../db/bun-sql-dialect.js').BunSubscription | null = null;
  private running = false;
  private databaseUrl = '';

  async start(databaseUrl: string): Promise<void> {
    if (this.running) return;
    this.databaseUrl = databaseUrl;

    try {
      // @ts-expect-error — Bun.SQL global tipat de bun-types
      const sql = new Bun.SQL(databaseUrl, { max: 1 });

      this.subscription = await sql.subscribe(
        'zveltio_changes',
        (rawPayload: string) => {
          let payload: any;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            return; // Payload malformat — ignorăm
          }

          const { collection, event, record_id, data } = payload;
          if (!collection || !event) return;

          // Map pg_notify event names → ws.ts broadcastEvent event names
          const eventMap: Record<string, 'insert' | 'update' | 'delete'> = {
            'record.created': 'insert',
            'record.updated': 'update',
            'record.deleted': 'delete',
          };

          const wsEvent = eventMap[event];
          if (!wsEvent) return;

          broadcastEvent(collection, wsEvent, data ?? { id: record_id });
        },
      );

      this.running = true;
      console.log('✅ Realtime LISTEN/NOTIFY started (Bun.SQL native)');
    } catch (err: any) {
      console.warn('[realtime] Failed to start LISTEN/NOTIFY:', err.message);
      // Non-fatal — single-instance realtime funcționează via direct broadcastEvent()
      // Retry după 5s
      setTimeout(() => this.start(databaseUrl), 5_000);
    }
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
      } catch { /* ignore */ }
      this.subscription = null;
    }
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export const realtimeManager = new RealtimeManager();

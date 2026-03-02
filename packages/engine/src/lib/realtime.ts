import { Client as PgClient } from 'pg';
import { broadcastEvent } from '../routes/ws.js';

/**
 * RealtimeManager — PostgreSQL LISTEN/NOTIFY bridge for multi-instance realtime.
 *
 * Maintains a dedicated pg.Client connection for LISTEN on 'zveltio_changes'.
 * When a notification arrives, it distributes the event to all in-process
 * WebSocket subscribers via broadcastEvent() from routes/ws.ts.
 *
 * This enables cross-instance realtime in horizontally-scaled deployments:
 *   Instance A: data.ts PATCH → pg_notify('zveltio_changes', payload)
 *   Instance B: RealtimeManager LISTEN → receives payload → broadcastEvent()
 */
export class RealtimeManager {
  private pgListener: PgClient | null = null;
  private running = false;

  async start(databaseUrl: string): Promise<void> {
    if (this.running) return;

    try {
      this.pgListener = new PgClient({ connectionString: databaseUrl });
      await this.pgListener.connect();

      await this.pgListener.query('LISTEN zveltio_changes');
      this.running = true;

      this.pgListener.on('notification', (msg: any) => {
        if (msg.channel !== 'zveltio_changes') return;

        let payload: any;
        try {
          payload = JSON.parse(msg.payload);
        } catch {
          return; // Malformed payload — skip
        }

        const { collection, event, record_id, data } = payload;
        if (!collection || !event) return;

        // Map pg_notify event names to ws.ts broadcastEvent event names
        const eventMap: Record<string, 'insert' | 'update' | 'delete'> = {
          'record.created': 'insert',
          'record.updated': 'update',
          'record.deleted': 'delete',
        };

        const wsEvent = eventMap[event];
        if (!wsEvent) return;

        broadcastEvent(
          collection,
          wsEvent,
          data ?? { id: record_id },
        );
      });

      this.pgListener.on('error', (err: Error) => {
        console.warn('[realtime] pg LISTEN error:', err.message);
        this.running = false;
        // Attempt reconnect after delay
        setTimeout(() => this.start(databaseUrl), 5000);
      });

      console.log('✅ Realtime LISTEN/NOTIFY started');
    } catch (err: any) {
      console.warn('[realtime] Failed to start LISTEN/NOTIFY:', err.message);
      // Non-fatal — single-instance realtime still works via direct broadcastEvent()
    }
  }

  async stop(): Promise<void> {
    if (this.pgListener) {
      try {
        await this.pgListener.end();
      } catch { /* ignore */ }
      this.pgListener = null;
    }
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export const realtimeManager = new RealtimeManager();

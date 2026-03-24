import { broadcastEvent } from '../routes/ws.js';

/**
 * RealtimeManager — PostgreSQL LISTEN/NOTIFY bridge for multi-instance realtime.
 *
 * Uses Bun.SQL.subscribe() (Bun 1.2+) instead of pg.Client for LISTEN,
 * eliminating dependency on `pg` and benefiting from native Bun I/O.
 *
 * Flow:
 *   Instance A: data.ts PATCH → pg_notify('zveltio_changes', payload)
 *   Instance B: RealtimeManager subscribe → receives payload → broadcastEvent()
 */
const REALTIME_RETRY_BASE_MS = 1_000; // Initial retry delay
const REALTIME_RETRY_MAX_MS = 300_000; // Cap at 5 minutes

export class RealtimeManager {
  // @ts-ignore — BunSubscription tipat de bun-types
  private subscription:
    | import('../db/bun-sql-dialect.js').BunSubscription
    | null = null;
  private running = false;
  private databaseUrl = '';
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  async start(databaseUrl: string): Promise<void> {
    if (this.running) return;
    this.databaseUrl = databaseUrl;

    try {
      // @ts-ignore — Bun.SQL global tipat de bun-types
      // No pool options — subscribe() requires a raw (non-pooled) SQL instance.
      const sql = new Bun.SQL(databaseUrl);

      // @ts-ignore — Bun.SQL.subscribe exists at runtime but not in TS types
      this.subscription = await sql.subscribe(
        'zveltio_changes',
        (rawPayload: string) => {
          let payload: any;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            return; // Malformed payload — ignore
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
      this.retryAttempt = 0; // Reset on success
      console.log('✅ Realtime LISTEN/NOTIFY started (Bun.SQL native)');
    } catch (err: any) {
      // If subscribe is not available (e.g. compiled binary without native support),
      // do not retry — it will never succeed and would spam the logs.
      if (err.message?.includes('is not a function')) {
        console.warn('[realtime] LISTEN/NOTIFY not available in this environment — single-instance realtime only.');
        return;
      }
      const delayMs = Math.min(
        REALTIME_RETRY_BASE_MS * Math.pow(2, this.retryAttempt),
        REALTIME_RETRY_MAX_MS,
      );
      this.retryAttempt++;
      console.warn(
        `[realtime] Failed to start LISTEN/NOTIFY (attempt ${this.retryAttempt}), retrying in ${delayMs}ms:`,
        err.message,
      );
      // Non-fatal — single-instance realtime works via direct broadcastEvent()
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.start(databaseUrl);
      }, delayMs);
    }
  }

  async stop(): Promise<void> {
    // Cancel any pending retry timer so a stopped manager doesn't resurrect itself.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
      } catch {
        /* ignore */
      }
      this.subscription = null;
    }
    this.running = false;
    this.retryAttempt = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export const realtimeManager = new RealtimeManager();

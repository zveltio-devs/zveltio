import { getCache } from './cache.js';
import { WebhookManager } from './webhooks.js';

let _running = false;
let _interval: ReturnType<typeof setInterval> | null = null;

export const webhookWorker = {
  start(pollMs = 1000): void {
    if (_running) return;
    _running = true;
    _interval = setInterval(() => {
      this._process().catch((err) => {
        console.error('[WebhookWorker] Unexpected error in _process:', err);
      });
    }, pollMs);
  },

  stop(): void {
    _running = false;
    if (_interval) {
      clearInterval(_interval);
      _interval = null;
    }
  },

  async _process(): Promise<void> {
    const cache = getCache();
    if (!cache) return;

    // LMPOP — atomic, single round-trip Redis, no race conditions
    // Fallback to LPOP in loop if server doesn't support LMPOP (Redis < 7.0)
    let items: string[] = [];
    try {
      const result = await (cache as any).lmpop(
        1,
        'webhook:queue',
        'LEFT',
        'COUNT',
        10,
      );
      // LMPOP returns [key, [item1, item2, ...]] or null
      if (result && Array.isArray(result[1])) {
        items = result[1];
      }
    } catch {
      // Fallback for older Redis/Valkey versions
      for (let i = 0; i < 10; i++) {
        const item = await cache.lpop('webhook:queue');
        if (!item) break;
        items.push(item);
      }
    }

    // Deliver all items concurrently — O(1) wall-clock instead of O(N × timeout)
    await Promise.all(
      items.map(async (item) => {
        let payload: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          secret?: string | null;
          timeout?: number;
          event: string;
          collection: string;
          data: any;
          timestamp: string;
          attempt: number;
          retryAttempts?: number;
        };
        try {
          payload = JSON.parse(item);
        } catch {
          // Malformed item in queue — log and discard to unblock delivery of other webhooks
          console.error('[WebhookWorker] Discarding malformed queue item:', item.slice(0, 200));
          return;
        }

        const ok = await WebhookManager.deliver(payload);

        if (!ok && payload.attempt < (payload.retryAttempts ?? 3)) {
          const retryPayload = { ...payload, attempt: payload.attempt + 1 };
          // Exponential backoff: 1s → 2s → 4s
          const delayMs = Math.pow(2, payload.attempt) * 1000;
          await cache.zadd(
            'webhook:retry',
            Date.now() + delayMs,
            JSON.stringify(retryPayload),
          );
        }
      }),
    );

    // Re-enqueue retries that are now due
    const due = await cache.zrangebyscore(
      'webhook:retry',
      '-inf',
      Date.now(),
      'LIMIT',
      0,
      10,
    );
    for (const item of due) {
      await cache.zrem('webhook:retry', item);
      await cache.rpush('webhook:queue', item);
    }
  },
};

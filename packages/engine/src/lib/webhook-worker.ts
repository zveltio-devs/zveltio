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

    // Collect up to 10 items from the queue
    const items: string[] = [];
    for (let i = 0; i < 10; i++) {
      const item = await cache.lpop('webhook:queue');
      if (!item) break;
      items.push(item);
    }

    // Deliver all items concurrently — O(1) wall-clock instead of O(N × timeout)
    await Promise.all(
      items.map(async (item) => {
        const payload = JSON.parse(item) as {
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

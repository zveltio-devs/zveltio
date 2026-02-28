import { getRedis } from './redis.js';
import { WebhookManager } from './webhooks.js';

let _running = false;
let _interval: ReturnType<typeof setInterval> | null = null;

export const webhookWorker = {
  start(pollMs = 1000): void {
    if (_running) return;
    _running = true;
    _interval = setInterval(() => {
      this._process().catch(() => {});
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
    const redis = getRedis();
    if (!redis) return;

    // Drain up to 10 queued deliveries per tick
    for (let i = 0; i < 10; i++) {
      const item = await redis.lpop('webhook:queue');
      if (!item) break;

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
        await redis.zadd('webhook:retry', Date.now() + delayMs, JSON.stringify(retryPayload));
      }
    }

    // Re-enqueue retries that are now due
    const due = await redis.zrangebyscore('webhook:retry', '-inf', Date.now(), 'LIMIT', 0, 10);
    for (const item of due) {
      await redis.zrem('webhook:retry', item);
      await redis.rpush('webhook:queue', item);
    }
  },
};

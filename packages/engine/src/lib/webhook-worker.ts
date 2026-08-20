import {
  getCache,
  webhookDeliveries,
  webhookDeliveryDuration,
  webhookRetries,
} from './runtime/index.js';
import type Redis from 'ioredis';
import { WebhookManager } from './webhooks.js';

let _running = false;
let _interval: ReturnType<typeof setInterval> | null = null;

/** Redis key holding webhooks that exhausted their retries. */
export const WEBHOOK_DLQ_KEY = 'webhook:dlq';

/**
 * How many abandoned deliveries to keep.
 *
 * Bounded because the failure mode this exists for — an endpoint that has been
 * down for a week — is exactly the one that produces the most entries. Newest
 * are kept: an old payload is the least likely to still be worth replaying.
 */
const DLQ_MAX = parseInt(process.env.WEBHOOK_DLQ_MAX ?? '') || 1000;

async function pushToDeadLetter(
  cache: Redis,
  payload: { url?: string; event?: string; attempt: number },
): Promise<void> {
  console.error(
    `[WebhookWorker] giving up on ${payload.event ?? 'event'} → ${payload.url ?? 'unknown url'} ` +
      `after ${payload.attempt + 1} attempt(s); moved to the dead-letter queue`,
  );
  try {
    await cache.lpush(
      WEBHOOK_DLQ_KEY,
      JSON.stringify({ ...payload, failedAt: new Date().toISOString() }),
    );
    await cache.ltrim(WEBHOOK_DLQ_KEY, 0, DLQ_MAX - 1);
  } catch (err) {
    // The cache being unavailable is why we are here in the first place for
    // some failures; losing the record is bad but must not stop the worker.
    console.error('[WebhookWorker] could not write to the dead-letter queue:', err);
  }
}

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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const result = await (cache as any).lmpop(1, 'webhook:queue', 'LEFT', 'COUNT', 10);
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
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

        const started = performance.now();
        const ok = await WebhookManager.deliver(payload);
        webhookDeliveryDuration.observe({}, (performance.now() - started) / 1000);
        webhookDeliveries.inc({ status: ok ? 'success' : 'failed' });

        if (!ok && payload.attempt < (payload.retryAttempts ?? 3)) {
          webhookRetries.inc({});
          const retryPayload = { ...payload, attempt: payload.attempt + 1 };
          // Exponential backoff: 1s → 2s → 4s
          const delayMs = Math.pow(2, payload.attempt) * 1000;
          await cache.zadd('webhook:retry', Date.now() + delayMs, JSON.stringify(retryPayload));
        } else if (!ok) {
          // Retries exhausted. This used to be the end of it: the payload fell
          // out of the loop and was gone, with nothing written down. A webhook
          // is how the outside world learns something happened here, so a
          // silent drop is a business event that quietly did not occur — and
          // the operator has no way to know, since the delivery metric counts
          // failures the same whether they were retried or abandoned.
          //
          // The payload is kept so it can be inspected and replayed, capped so
          // an endpoint that is down for a week cannot fill the cache.
          await pushToDeadLetter(cache, payload);
        }
      }),
    );

    // Re-enqueue retries that are now due
    const due = await cache.zrangebyscore('webhook:retry', '-inf', Date.now(), 'LIMIT', 0, 10);
    for (const item of due) {
      await cache.zrem('webhook:retry', item);
      await cache.rpush('webhook:queue', item);
    }
  },
};

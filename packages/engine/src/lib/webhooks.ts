import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './cache.js';
import { validatePublicUrl, safeFetch } from './edge-functions/safe-fetch.js';
import { maybeDecrypt } from './field-crypto.js';

let _db: Database | null = null;

export const WebhookManager = {
  init(db: Database): void {
    _db = db;
  },

  async trigger(
    event: string,
    collection: string,
    data: { id: string; [key: string]: any },
  ): Promise<void> {
    if (!_db) return;
    try {
      const matchResult = await sql<any>`
        SELECT * FROM zvd_webhooks
        WHERE active = true
          AND (events @> ARRAY[${event}]::text[] OR events @> ARRAY['*']::text[])
          AND (
            collections IS NULL
            OR cardinality(collections) = 0
            OR collections @> ARRAY[${collection}]::text[]
            OR collections @> ARRAY['*']::text[]
          )
      `.execute(_db as Database);
      const matching = matchResult.rows;

      const cache = getCache();
      for (const wh of matching) {
        // Create a delivery record immediately so the entry exists regardless of
        // HTTP delivery timing. Updated with status/error/delivered_at after delivery.
        let deliveryId: string | null = null;
        try {
          const deliveryRow = await (_db as any)
            .insertInto('zvd_webhook_deliveries')
            .values({
              webhook_id: wh.id,
              payload: JSON.stringify({
                event,
                collection,
                data,
                timestamp: new Date().toISOString(),
              }),
              url: wh.url,
              method: wh.method || 'POST',
              headers: JSON.stringify((wh.headers as Record<string, string>) || {}),
              attempt: 1,
              max_attempts: wh.retry_attempts ?? 3,
            })
            .returning('id')
            .executeTakeFirst();
          deliveryId = (deliveryRow as any)?.id ?? null;
        } catch {
          /* non-fatal — delivery record missing won't block the webhook queue */
        }

        // Decrypt the signing secret in memory before queueing. The DB
        // column stores the AES-256-GCM ciphertext (enc:v1:...) — if
        // it were plaintext, anyone with read access to zvd_webhooks
        // could forge valid webhook signatures and impersonate the
        // engine to the recipient. The plaintext lives only for the
        // duration of this delivery — Valkey queue carries it
        // transiently, then it's GC'd.
        let plaintextSecret: string | null = null;
        if (wh.secret) {
          try {
            const decrypted = await maybeDecrypt(wh.secret, true);
            plaintextSecret = typeof decrypted === 'string' ? decrypted : null;
          } catch (err) {
            console.warn(
              `[webhooks] failed to decrypt secret for webhook ${wh.id}:`,
              (err as Error).message,
            );
            plaintextSecret = null;
          }
        }

        const payload = {
          webhookId: wh.id,
          deliveryId,
          url: wh.url,
          method: wh.method || 'POST',
          headers: (wh.headers as Record<string, string>) || {},
          secret: plaintextSecret,
          timeout: wh.timeout || 5000,
          retryAttempts: wh.retry_attempts ?? 3,
          event,
          collection,
          data,
          timestamp: new Date().toISOString(),
          attempt: 0,
        };

        if (cache) {
          await cache.rpush('webhook:queue', JSON.stringify(payload));
        } else {
          // No cache — fire-and-forget directly
          WebhookManager.deliver(payload).catch(() => {});
        }
      }
    } catch {
      /* non-fatal */
    }
  },

  async deliver(payload: {
    webhookId?: string;
    deliveryId?: string | null;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    secret?: string | null;
    timeout?: number;
    retryAttempts?: number;
    attempt?: number;
    event: string;
    collection: string;
    data: any;
    timestamp: string;
  }): Promise<boolean> {
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let ok = false;

    try {
      const body = JSON.stringify({
        event: payload.event,
        collection: payload.collection,
        data: payload.data,
        timestamp: payload.timestamp,
      });

      // Filter out headers that could be exploited if webhook config is compromised
      // (e.g. credential injection, cookie theft, host header poisoning).
      const BLOCKED_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'host',
        'x-forwarded-for',
        'x-real-ip',
        'x-forwarded-host',
        'x-original-url',
        'x-rewrite-url',
        'proxy-authorization',
        'www-authenticate',
      ]);

      const safeCustomHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload.headers || {})) {
        if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
          safeCustomHeaders[k] = v;
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...safeCustomHeaders,
      };

      if (payload.secret) {
        // HMAC-SHA256 signature
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(payload.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
        headers['X-Zveltio-Signature'] = `sha256=${Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`;
      }

      validatePublicUrl(payload.url); // throws error if URL is internal
      const response = await safeFetch(payload.url, {
        method: payload.method || 'POST',
        headers,
        body,
        // Clamp the timeout to [100 ms, 30 s] so a bad value in the DB
        // (compromised config, manual edit) can't produce 0/negative/infinite waits.
        signal: AbortSignal.timeout(Math.min(Math.max(payload.timeout || 5_000, 100), 30_000)),
      });

      httpStatus = response.status;
      ok = response.ok;

      // Read a short snippet of the response body for the delivery log
      try {
        const text = await response.text();
        responseBody = text.slice(0, 2_000);
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Request failed';
    }

    // Update delivery record with outcome (non-fatal)
    if (_db && payload.deliveryId) {
      (_db as any)
        .updateTable('zvd_webhook_deliveries')
        .set({
          status: httpStatus,
          response_body: responseBody,
          error: errorMessage,
          delivered_at: ok ? new Date() : null,
        })
        .where('id', '=', payload.deliveryId)
        .execute()
        .catch(() => {});
    }

    return ok;
  },
};

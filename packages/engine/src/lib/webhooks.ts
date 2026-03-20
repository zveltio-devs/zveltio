import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './cache.js';
import { validatePublicUrl, safeFetch } from './edge-functions/safe-fetch.js';

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
          AND (events @> ${JSON.stringify([event])}::jsonb OR events @> '["*"]'::jsonb)
          AND (
            collections = '[]'::jsonb
            OR collections @> ${JSON.stringify([collection])}::jsonb
            OR collections @> '["*"]'::jsonb
          )
      `.execute(_db as Database);
      const matching = matchResult.rows;

      const cache = getCache();
      for (const wh of matching) {
        const payload = {
          webhookId: wh.id,
          url: wh.url,
          method: wh.method || 'POST',
          headers: (wh.headers as Record<string, string>) || {},
          secret: wh.secret || null,
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
    url: string;
    method?: string;
    headers?: Record<string, string>;
    secret?: string | null;
    timeout?: number;
    event: string;
    collection: string;
    data: any;
    timestamp: string;
  }): Promise<boolean> {
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
        headers['X-Zveltio-Signature'] = `sha256=${Array.from(
          new Uint8Array(sig),
        )
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}`;
      }

      validatePublicUrl(payload.url); // throws error if URL is internal
      const response = await safeFetch(payload.url, {
        method: payload.method || 'POST',
        headers,
        body,
        // H1 FIX: Clamp timeout to [100ms, 30s] — prevents 0/negative/infinite waits
        // even if the DB row contains a bad value from a compromised config.
        signal: AbortSignal.timeout(
          Math.min(Math.max(payload.timeout || 5_000, 100), 30_000),
        ),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};

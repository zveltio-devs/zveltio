import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './runtime/index.js';
import { validatePublicUrl, safeFetch } from './edge-functions/safe-fetch.js';
import { maybeDecrypt } from './data/index.js';
import { DEFAULT_TENANT_ID } from './route-db.js';
import { toJsonb } from './jsonb.js';
import { withSavepoint } from './savepoint.js';
import { withEveryTenant, withTenantIsolation } from './tenancy/index.js';

let _db: Database | null = null;

/**
 * Give every unsigned webhook a signing secret, once, at boot.
 *
 * `POST /api/webhooks` has generated a secret for every webhook since
 * alpha.32 — but only for webhooks created after alpha.32. Rows older than
 * that kept `secret = NULL`, and the delivery path signs conditionally
 * (`if (payload.secret)`), so those webhooks have been posting unsigned
 * payloads ever since. A receiver has no way to tell such a delivery from
 * anyone else who learned the URL, and nothing anywhere reports it: the
 * webhook works, the deliveries succeed, and the missing header is not an
 * error to either side.
 *
 * Repaired here rather than in a migration because the column is encrypted
 * with FIELD_ENCRYPTION_KEY through `maybeEncrypt`, which SQL cannot reach.
 * Writing a plaintext secret into an otherwise-encrypted column would trade
 * one silent inconsistency for another.
 *
 * Non-breaking by construction: a receiver that was never given a secret
 * cannot have been verifying signatures, so gaining a header it ignores costs
 * it nothing. It does mean the operator must fetch the new secret and
 * configure it before the signature is worth anything, which is what the log
 * line is for.
 */
export async function repairUnsignedWebhooksAtBoot(db: Database): Promise<number> {
  try {
    // Every firm's rows: `zvd_webhooks` is under the tenant policy (migration
    // 028), and on the bare pool a non-superuser database shows the default
    // firm's only — every other firm's unsigned webhook stayed unsigned.
    return await withEveryTenant(db, (trx) => repairUnsigned(trx));
  } catch (err) {
    // Non-fatal: a webhook that cannot be repaired is no worse off than it was
    // this morning, and refusing to boot over it would be out of proportion.
    console.warn('[webhooks] could not repair unsigned webhooks:', (err as Error).message);
    return 0;
  }
}

async function repairUnsigned(db: Database): Promise<number> {
  const { rows } = await sql<{ id: string; name: string | null; tenant_id: string }>`
    SELECT id, name, tenant_id::text AS tenant_id FROM zvd_webhooks
     WHERE secret IS NULL OR secret = ''
  `.execute(db);
  if (rows.length === 0) return 0;

  const { maybeEncrypt } = await import('./data/index.js');

  // The secret column is an `encrypted: true` field, and `maybeEncrypt`
  // refuses to write one without FIELD_ENCRYPTION_KEY. Checked once, up
  // front, because the alternative — discovering it inside the loop — turns
  // "this install still delivers unsigned webhooks" into a line that reads
  // like a transient hiccup and stops the repair for every remaining row.
  try {
    await maybeEncrypt('probe', true);
  } catch (err) {
    console.warn(
      `⚠️  [webhooks] ${rows.length} webhook(s) have no signing secret and will keep ` +
        'delivering unsigned payloads: a secret cannot be stored because ' +
        `${(err as Error).message}`,
    );
    return 0;
  }

  let repaired = 0;
  for (const row of rows) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const stored = (await maybeEncrypt(secret, true)) as string;
    // The policy's WITH CHECK admits a write for `zveltio.current_tenant` only.
    await sql`SELECT set_config('zveltio.current_tenant', ${row.tenant_id}, true)`.execute(db);
    await sql`UPDATE zvd_webhooks SET secret = ${stored} WHERE id = ${row.id}`.execute(db);
    repaired++;
    console.warn(
      `⚠️  [webhooks] "${row.name ?? row.id}" had no signing secret and was delivering ` +
        'unsigned payloads. A secret has been generated — rotate it from the admin UI and ' +
        'configure the receiver to verify X-Zveltio-Signature.',
    );
  }
  return repaired;
}

/**
 * Deliveries dispatched without a cache queue, still running.
 *
 * `trigger` returns as soon as it has handed each payload to `deliver`, which
 * is the right behaviour — a write must not wait on someone else's HTTP
 * endpoint. It left tests with nothing to await, so they polled a wall clock
 * instead: first a 50ms sleep, which failed on CI at 52.27ms, then a 2s
 * deadline, which failed on CI at 2007ms. Each fix widened the window and kept
 * the race.
 */
const _inFlight = new Set<Promise<unknown>>();

/**
 * Resolve once every cache-less delivery started so far has finished.
 *
 * Test-only. Production never needs it: with a cache the payload goes to the
 * queue and the worker owns it from there.
 */
export async function _settleWebhookDeliveries(): Promise<void> {
  // A loop rather than one `Promise.all`: a delivery can start another, and
  // awaiting the first snapshot would return with the second still running.
  while (_inFlight.size > 0) {
    await Promise.all([..._inFlight]);
  }
}

/** One delivery, as it travels through the queue and into `deliver`. */
export interface DeliveryPayload {
  webhookId?: string;
  deliveryId?: string | null;
  /** The delivery row's firm — its outcome is written as that firm. Absent on
   * a payload queued before migration 028, which could only be the default. */
  tenantId?: string | null;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  secret?: string | null;
  timeout?: number;
  retryAttempts?: number;
  attempt?: number;
  event: string;
  collection: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  data: any;
  timestamp: string;
}

/**
 * Write to one delivery row as the row's firm. Under the tenant policy
 * (migration 028) the bare pool of a non-superuser database skips every other
 * firm's row without an error, so its outcome and retry count went nowhere.
 */
async function recordOutcome(
  payload: DeliveryPayload,
  values: Record<string, unknown>,
): Promise<void> {
  const id = payload.deliveryId;
  if (!_db || !id) return;
  await withTenantIsolation(payload.tenantId ?? DEFAULT_TENANT_ID, (trx) =>
    trx
      .updateTable('zvd_webhook_deliveries')
      .set(values as never)
      .where('id', '=', id)
      .execute(),
  );
}

export const WebhookManager = {
  init(db: Database): void {
    _db = db;
  },

  async trigger(
    event: string,
    collection: string,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    data: { id: string; [key: string]: any },
    // Tenant of the write that fired this event (threaded from afterWrite —
    // the dispatcher runs on the GLOBAL pool, not inside the request
    // transaction, so it can't read `current_setting('zveltio.current_tenant')`).
    // Without this filter a write in tenant A would fire tenant B's webhooks and
    // POST A's record data to B's endpoint (cross-tenant data exfiltration).
    tenantId?: string | null,
  ): Promise<void> {
    if (!_db) return;
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    try {
      // Inside the writing firm: both tables are under the tenant policy
      // (migration 028), and on the bare pool a non-superuser database shows the
      // default firm's webhooks only — every other firm's never fired.
      //
      // Committed before anything is queued: the outcome is written to the
      // delivery row by id from another connection, which cannot see it earlier.
      const matching = await withTenantIsolation(tenant, async (trx) => {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const matchResult = await sql<any>`
          SELECT * FROM zvd_webhooks
          WHERE active = true
            AND tenant_id = ${tenant}::uuid
            AND (events @> ARRAY[${event}]::text[] OR events @> ARRAY['*']::text[])
            AND (
              collections IS NULL
              OR cardinality(collections) = 0
              OR collections @> ARRAY[${collection}]::text[]
              OR collections @> ARRAY['*']::text[]
            )
        `.execute(trx);
        const out = [];
        for (const wh of matchResult.rows) {
          // Create a delivery record immediately so the entry exists regardless of
          // HTTP delivery timing. Updated with status/error/delivered_at after
          // delivery. Non-fatal — a missing record won't block the webhook queue —
          // and in a savepoint, or one refused insert aborts every later one.
          const deliveryId = await withSavepoint(
            trx,
            'webhook_delivery',
            async () => {
              const row = await trx
                .insertInto('zvd_webhook_deliveries')
                .values({
                  webhook_id: wh.id,
                  payload: toJsonb({
                    event,
                    collection,
                    data,
                    timestamp: new Date().toISOString(),
                  }),
                  url: wh.url,
                  method: wh.method || 'POST',
                  headers: toJsonb((wh.headers as Record<string, string>) || {}),
                  attempt: 1,
                  max_attempts: wh.retry_attempts ?? 3,
                  tenant_id: wh.tenant_id ?? tenant,
                } as never)
                .returning('id')
                .executeTakeFirst();
              return (row?.id as string | undefined) ?? null;
            },
            () => null,
          );
          out.push({ wh, deliveryId });
        }
        return out;
      });

      const cache = getCache();
      for (const { wh, deliveryId } of matching) {
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
          tenantId: (wh.tenant_id as string | null) ?? tenant,
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
          // No cache — deliver in-process. Tracked so a test can await the
          // delivery instead of racing a wall clock; see
          // `_settleWebhookDeliveries`.
          const p = WebhookManager._deliverWithRetries(payload).catch(() => {});
          _inFlight.add(p);
          void p.finally(() => _inFlight.delete(p));
        }
      }
    } catch {
      /* non-fatal */
    }
  },

  /**
   * Deliver, retry, and write down the abandonment — the no-cache path's
   * equivalent of the worker plus its dead-letter queue.
   *
   * Without a cache this used to be one `deliver(payload).catch(() => {})`.
   * `retryAttempts` rides on the payload and is read only by the worker, so a
   * failed delivery was attempted once and discarded with no record anywhere:
   * the DLQ exists only on the cache path, and a cache is not a documented
   * requirement for webhooks. A webhook is how the outside world learns
   * something happened here, so a silent drop is a business event that quietly
   * did not occur.
   *
   * There is no queue to abandon the payload into, but there is already a row:
   * `zvd_webhook_deliveries` carries `attempt` and `error`, so the delivery log
   * the admin UI already reads becomes the record. The backoff matches the
   * worker's — 1s, 2s, 4s — and `sleep` is injected so a test does not wait it out.
   */
  async _deliverWithRetries(
    payload: DeliveryPayload,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<boolean> {
    const maxAttempts = payload.retryAttempts ?? 3;
    for (let attempt = 0; ; attempt++) {
      const ok = await WebhookManager.deliver({ ...payload, attempt });
      if (ok) return true;
      if (attempt >= maxAttempts) {
        console.error(
          `[webhooks] giving up on ${payload.event} → ${payload.url} after ` +
            `${attempt + 1} attempt(s); no cache is configured, so there is no dead-letter ` +
            'queue to replay it from — the delivery row carries the final error',
        );
        await recordOutcome(payload, { attempt: attempt + 1 }).catch(() => {});
        return false;
      }
      await sleep(2 ** attempt * 1000);
    }
  },

  async deliver(payload: DeliveryPayload): Promise<boolean> {
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
    void recordOutcome(payload, {
      status: httpStatus,
      response_body: responseBody,
      error: errorMessage,
      delivered_at: ok ? new Date() : null,
    }).catch(() => {});

    return ok;
  },
};

/**
 * Every handler reads through `reqDb(c, db)`, never the bare pool.
 *
 * Two reasons, and the second is the one that was costing something. The pool
 * escapes RLS: `zv_webhooks` carries `tenant_id` and a policy, but a query on
 * the pool runs as the engine's own role, so the explicit `where tenant_id = …`
 * was the ONLY thing standing between tenants here. And a pool query issued
 * while the request already holds its tenant transaction is a SECOND connection
 * — at `c = DB_POOL_MAX` every connection is held by such a transaction and the
 * second can never arrive, so the instance stops rather than slows. This route
 * asked for four.
 *
 * The `where tenant_id` clauses stay: belt AND braces now, and they still let
 * the planner use the composite indexes.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { isTenantAdmin } from '../lib/tenancy/index.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import { safeFetch, validatePublicUrl } from '../lib/edge-functions/safe-fetch.js';
import { maybeEncrypt, maybeDecrypt } from '../lib/data/index.js';
import { getCache } from '../lib/runtime/index.js';
import { WEBHOOK_DLQ_KEY } from '../lib/webhook-worker.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await isTenantAdmin(session.user.id))) return null;
  return session.user;
}

const WebhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).min(1),
  collections: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  secret: z.string().optional(),
  retry_attempts: z.number().int().min(0).max(10).default(3),
  timeout: z.number().int().min(1000).max(30000).default(5000),
});

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function webhooksRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  /** Replace secret with a masked indicator — never expose plaintext secrets via API. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function maskSecret(webhook: any): any {
    if (!webhook) return webhook;
    return { ...webhook, secret: webhook.secret ? '••••••••' : null };
  }

  // ── Dead-letter queue ───────────────────────────────────────────────────
  //
  // Deliveries that exhausted their retries used to be dropped where they
  // stood. They are now kept, which is only half the job: a queue nobody can
  // read is a log file with extra steps. These two endpoints are the other
  // half — see what was abandoned, and send it again once the endpoint is
  // back.
  //
  // Filtered to this tenant's own webhooks so one tenant's admin cannot read
  // another's payloads out of a cache key they happen to share.
  //
  // Filtered by `webhookId`, not by URL. A URL is not an ownership claim: it is
  // a value any tenant can type into its own webhook, so registering a webhook
  // at the URL another tenant already uses used to hand over that tenant's
  // abandoned payloads — which carry the record data of the write that fired
  // them — and let `replay` remove them from the DLQ and re-send them.
  // The id comes from `zvd_webhooks` on both sides and cannot be claimed.

  /** This tenant's webhooks by id — the DLQ is a flat Redis list, not a table. */
  async function ownWebhooks(c: Context): Promise<Map<string, { secret: string | null }>> {
    const rows = await reqDb(c, db)
      .selectFrom('zvd_webhooks')
      .select(['id', 'secret'])
      .where('tenant_id', '=', tenantId(c))
      .execute();
    return new Map(rows.map((r) => [r.id as string, { secret: (r.secret as string) ?? null }]));
  }

  /** An entry as it sits in the DLQ. `secret` is never one of its fields. */
  type DlqEntry = { webhookId?: string } & Record<string, unknown>;

  function parseEntry(raw: string): DlqEntry | null {
    try {
      const parsed = JSON.parse(raw) as DlqEntry;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // GET /dlq — abandoned deliveries, newest first. Declared before `/:id` so
  // the param route does not capture "dlq".
  app.get('/dlq', async (c) => {
    const cache = getCache();
    if (!cache) return c.json({ entries: [], available: false });
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50') || 50, 500);
    const raw: string[] = await cache.lrange(WEBHOOK_DLQ_KEY, 0, limit - 1).catch(() => []);
    const mine = await ownWebhooks(c);
    const entries = raw
      .map(parseEntry)
      .filter((e): e is DlqEntry => e !== null && !!e.webhookId && mine.has(e.webhookId))
      // `secret` is stripped before an entry reaches the DLQ, but an entry
      // abandoned by an older worker still carries it and every other handler
      // here masks the signing secret. Dropped on the way out too.
      .map(({ secret: _secret, ...rest }) => rest);
    return c.json({ entries, available: true });
  });

  // POST /dlq/replay — put abandoned deliveries back on the queue.
  app.post('/dlq/replay', async (c) => {
    const cache = getCache();
    if (!cache) return c.json({ error: 'Cache unavailable' }, 503);
    const raw: string[] = await cache.lrange(WEBHOOK_DLQ_KEY, 0, -1).catch(() => []);
    const mine = await ownWebhooks(c);
    let replayed = 0;
    for (const item of raw) {
      const parsed = parseEntry(item);
      if (!parsed?.webhookId) continue;
      const owner = mine.get(parsed.webhookId);
      if (!owner) continue;
      // The DLQ does not store the signing secret, so a replay that just
      // re-queued the entry would deliver UNSIGNED — the receiver's verification
      // would fail, or worse, it accepts unsigned and nothing reports it.
      // Re-read and decrypt it from the webhook row instead.
      let secret: string | null = null;
      if (owner.secret) {
        try {
          const plain = await maybeDecrypt(owner.secret, true);
          secret = typeof plain === 'string' ? plain : null;
        } catch (err) {
          console.warn(
            `[webhooks] replay: could not decrypt the secret for ${parsed.webhookId}:`,
            (err as Error).message,
          );
        }
      }
      // `attempt: 0` so the replay gets the full retry budget again rather
      // than one last try — the endpoint being back is a new situation.
      const { failedAt: _failedAt, secret: _stale, ...payload } = parsed as Record<string, unknown>;
      await cache.rpush('webhook:queue', JSON.stringify({ ...payload, secret, attempt: 0 }));
      await cache.lrem(WEBHOOK_DLQ_KEY, 1, item);
      replayed++;
    }
    return c.json({ replayed });
  });

  // GET / — List all webhooks
  app.get('/', async (c) => {
    const webhooks = await reqDb(c, db)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('tenant_id', '=', tenantId(c))
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ webhooks: webhooks.map(maskSecret) });
  });

  // GET /:id — Get webhook
  app.get('/:id', async (c) => {
    const webhook = await reqDb(c, db)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ webhook: maskSecret(webhook) });
  });

  // POST / — Create webhook
  app.post('/', zValidator('json', WebhookSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    // SSRF protection: reject URLs targeting internal/private networks
    try {
      validatePublicUrl(data.url);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid webhook URL' }, 400);
    }

    // Auto-generate secret if not provided — always sign deliveries
    const secret = data.secret || generateWebhookSecret();

    // Encrypt the signing secret with FIELD_ENCRYPTION_KEY before
    // persisting. The plaintext is returned ONCE to the admin via the
    // response so they can configure the receiving service; from then
    // on the DB column holds enc:v1:... ciphertext. WebhookManager
    // decrypts in memory just before each delivery.
    const encryptedSecret = (await maybeEncrypt(secret, true)) as string;

    const webhook = await reqDb(c, db)
      .insertInto('zvd_webhooks')
      .values({ ...data, secret: encryptedSecret, created_by: user.id, tenant_id: tenantId(c) })
      .returningAll()
      .executeTakeFirst();

    // Return plaintext secret only on creation — subsequent GETs return masked value
    return c.json(
      { webhook: { ...webhook, secret: '••••••••' }, secret, _secret_shown_once: true },
      201,
    );
  });

  // PATCH /:id — Update webhook
  app.patch('/:id', zValidator('json', WebhookSchema.partial()), async (c) => {
    const data = c.req.valid('json');
    // SSRF protection on URL update
    if (data.url) {
      try {
        validatePublicUrl(data.url);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid webhook URL' }, 400);
      }
    }
    // Encrypt the secret if the caller is rotating it through PATCH —
    // same pattern as POST /. Without this branch a PATCH would write
    // plaintext over the encrypted column and leak the signing key.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const toSet: Record<string, any> = { ...data, updated_at: new Date() };
    if (typeof data.secret === 'string' && data.secret.length > 0) {
      toSet.secret = (await maybeEncrypt(data.secret, true)) as string;
    }
    const webhook = await reqDb(c, db)
      .updateTable('zvd_webhooks')
      .set(toSet)
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .returningAll()
      .executeTakeFirst();

    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ webhook: maskSecret(webhook) });
  });

  // DELETE /:id — Delete webhook
  app.delete('/:id', async (c) => {
    // DELETE ... RETURNING so a missing/cross-tenant id yields `undefined`
    // (→ 404) instead of a truthy DeleteResult. numDeletedRows is unreliable on
    // the Bun SQL dialect, so gate on the returned row like the other handlers.
    const deleted = await reqDb(c, db)
      .deleteFrom('zvd_webhooks')
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .returning('id')
      .executeTakeFirst();
    if (!deleted) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ success: true });
  });

  // GET /:id/deliveries — Delivery logs
  app.get('/:id/deliveries', async (c) => {
    const { limit = '50' } = c.req.query();
    const deliveries = await reqDb(c, db)
      .selectFrom('zvd_webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 500))
      .execute();
    return c.json({ deliveries });
  });

  // POST /:id/rotate-secret — Generate a new signing secret
  app.post('/:id/rotate-secret', async (c) => {
    const newSecret = generateWebhookSecret();
    const encryptedNew = (await maybeEncrypt(newSecret, true)) as string;
    const webhook = await reqDb(c, db)
      .updateTable('zvd_webhooks')
      .set({ secret: encryptedNew, updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .returningAll()
      .executeTakeFirst();
    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ secret: newSecret, webhook: maskSecret(webhook) });
  });

  // POST /:id/test — Test webhook
  app.post('/:id/test', async (c) => {
    const webhook = await reqDb(c, db)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();

    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);

    try {
      // Security: sanitize stored headers — block credential injection.
      const BLOCKED_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
        'x-auth-token',
        'x-forwarded-for',
        'x-real-ip',
        'x-zveltio-internal',
        'host',
        'origin',
        'referer',
      ]);
      const sanitizedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries(
        (webhook.headers as Record<string, string>) || {},
      )) {
        if (!BLOCKED_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
          sanitizedHeaders[key] = value;
        }
      }

      const testBody = JSON.stringify({
        event: 'test',
        collection: 'test',
        data: { message: 'Test webhook from Zveltio' },
        timestamp: new Date().toISOString(),
      });

      if (webhook.secret) {
        // The stored secret is encrypted (enc:v1:...) — decrypt in
        // memory to sign the test body. maybeDecrypt returns the value
        // unchanged on legacy unencrypted rows so test still works
        // during the encryption rollout.
        const plaintext = (await maybeDecrypt(webhook.secret, true)) as string;
        sanitizedHeaders['X-Zveltio-Signature'] = await signBody(testBody, plaintext);
      }

      validatePublicUrl(webhook.url as string);
      const response = await safeFetch(webhook.url as string, {
        method: (webhook.method as string) || 'POST',
        headers: sanitizedHeaders,
        body: testBody,
        signal: AbortSignal.timeout(webhook.timeout || 5000),
      });

      return c.json({
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (err) {
      return c.json({
        success: false,
        error: err instanceof Error ? err.message : 'Request failed',
      });
    }
  });

  return app;
}

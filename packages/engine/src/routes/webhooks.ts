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
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { holdsRole, isTenantAdmin, DEFAULT_RUN_AS_ROLE } from '../lib/tenancy/index.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import { safeFetch, validatePublicUrl } from '../lib/edge-functions/safe-fetch.js';
import { maybeEncrypt, maybeDecrypt } from '../lib/data/index.js';
import { enqueueReplay, type WebhookJob } from '../lib/webhooks.js';
import { guardAdmin } from '../lib/admin-guard.js';
import { paging } from '../lib/utils.js';

// The fields, with no defaults. A PATCH validates against these, partial:
// zod 4 applies a `.default()` inside `.partial()`, so a PATCH naming only the
// URL wrote `collections: []` (every collection), `active: true`, the default
// method, headers, retries and timeout over the stored ones.
const WebhookFields = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  method: z.enum(['POST', 'PUT', 'PATCH']),
  headers: z.record(z.string(), z.string()),
  events: z.array(z.string()).min(1),
  collections: z.array(z.string()),
  active: z.boolean(),
  secret: z.string().optional(),
  retry_attempts: z.number().int().min(0).max(10),
  timeout: z.number().int().min(1000).max(30000),
  // ADR 0004: the role its payloads are read as.
  run_as_role: z.string().min(1),
});

/** A new webhook: the fields, with the defaults a create fills in. */
const WebhookSchema = WebhookFields.extend({
  method: WebhookFields.shape.method.default('POST'),
  headers: WebhookFields.shape.headers.default({}),
  collections: WebhookFields.shape.collections.default([]),
  active: WebhookFields.shape.active.default(true),
  retry_attempts: WebhookFields.shape.retry_attempts.default(3),
  timeout: WebhookFields.shape.timeout.default(5000),
  // The tenant's member role when none is chosen.
  run_as_role: WebhookFields.shape.run_as_role.default(DEFAULT_RUN_AS_ROLE),
});

/** An edit: only the fields it names, never a default. */
export const WebhookPatchSchema = WebhookFields.partial();

/**
 * A webhook's role must be one its saver holds in this tenant (ADR 0004), on
 * every save: re-pointing a webhook that reads as a role the editor lacks
 * sends that role's view to the editor's URL. `null` (deleted) asks nothing.
 */
async function refuseRunAsRole(userId: string, role: string | null): Promise<Response | null> {
  if (role === null || (await holdsRole(userId, role))) return null;
  return Response.json(
    { error: `run_as_role "${role}": a webhook reads as a role you hold in this tenant` },
    { status: 403 },
  );
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * What a masked secret reads as on the wire — and what must never be stored.
 *
 * One constant rather than three literals, because the guard in PATCH has to
 * compare against exactly the string the read paths emit; two copies of a
 * bullet run are a typo away from a guard that never matches.
 */
const MASK = '••••••••';

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
    const user = await guardAdmin(c, auth, isTenantAdmin);
    if (user instanceof Response) return user;
    c.set('user', user);
    await next();
  });

  /** Replace secret with a masked indicator — never expose plaintext secrets via API. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function maskSecret(webhook: any): any {
    if (!webhook) return webhook;
    return { ...webhook, secret: webhook.secret ? MASK : null };
  }

  // ── Dead-letter list ────────────────────────────────────────────────────
  //
  // A delivery whose job used its last retry (ADR 0035): its row says so, with
  // the attempt past `max_attempts` and nothing delivered. Read through the
  // request's tenant, so one firm's admin sees and replays its own only. Rows
  // written before the delivery queue moved to pg-boss carry no event id and
  // cannot be replayed as an event; they are not listed.
  const deadLetters = (c: Parameters<typeof reqDb>[0], limit?: number) => {
    let q = reqDb(c, db)
      .selectFrom('zvd_webhook_deliveries as d')
      .innerJoin('zvd_webhooks as w', 'w.id', 'd.webhook_id')
      .select([
        'd.id',
        'd.webhook_id',
        'd.event_id',
        'd.payload',
        'd.url',
        'd.method',
        'd.attempt',
        'd.status',
        'd.error',
        'd.created_at',
        'w.retry_attempts',
      ])
      .where('d.tenant_id', '=', tenantId(c))
      .where('d.event_id', 'is not', null)
      .where('d.delivered_at', 'is', null)
      .whereRef('d.attempt', '>', 'd.max_attempts')
      .orderBy('d.created_at', 'desc');
    if (limit) q = q.limit(limit);
    return q.execute();
  };

  // GET /dlq — abandoned deliveries, newest first. Declared before `/:id` so
  // the param route does not capture "dlq".
  app.get('/dlq', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50') || 50, 500);
    const rows = await deadLetters(c, limit);
    const entries = rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        deliveryId: r.id,
        webhookId: r.webhook_id,
        eventId: r.event_id,
        sequence: p.sequence,
        event: p.event,
        collection: p.collection,
        data: p.data,
        timestamp: p.timestamp,
        url: r.url,
        method: r.method,
        attempt: r.attempt,
        status: r.status,
        error: r.error,
      };
    });
    return c.json({ entries, available: true });
  });

  // POST /dlq/replay — a new job for each abandoned delivery, with the full
  // retry budget again: the endpoint being back is a new situation. The same
  // event id, so a receiver that did get it once can tell. The row's attempt
  // goes back to 0 in the same transaction, so it leaves the list as its job
  // is queued, and the job writes its outcome over it.
  app.post('/dlq/replay', async (c) => {
    const trx = reqDb(c, db);
    const rows = await deadLetters(c);
    for (const r of rows) {
      const p = r.payload as Omit<WebhookJob, 'tenantId' | 'webhookId' | 'eventId'> & {
        id: string;
      };
      await enqueueReplay(
        trx,
        {
          tenantId: tenantId(c),
          webhookId: r.webhook_id,
          eventId: r.event_id as string,
          sequence: p.sequence,
          event: p.event,
          collection: p.collection,
          data: p.data,
          timestamp: p.timestamp,
        },
        r.retry_attempts ?? 3,
      );
      await trx
        .updateTable('zvd_webhook_deliveries')
        .set({ attempt: 0 })
        .where('id', '=', r.id)
        .where('tenant_id', '=', tenantId(c))
        .execute();
    }
    return c.json({ replayed: rows.length });
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
    const roleDenial = await refuseRunAsRole(user.id, data.run_as_role);
    if (roleDenial) return roleDenial;

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
    return c.json({ webhook: { ...webhook, secret: MASK }, secret, _secret_shown_once: true }, 201);
  });

  // PATCH /:id — Update webhook
  app.patch('/:id', zValidator('json', WebhookPatchSchema), async (c) => {
    const data = c.req.valid('json');
    const current = await reqDb(c, db)
      .selectFrom('zvd_webhooks')
      .select('run_as_role')
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantId(c))
      .executeTakeFirst();
    if (!current) return c.json({ error: 'Webhook not found' }, 404);
    const roleDenial = await refuseRunAsRole(
      (c.get('user') as { id: string }).id,
      data.run_as_role ?? current.run_as_role,
    );
    if (roleDenial) return roleDenial;
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
    // Never write the mask back over the secret it stands for.
    //
    // `maskSecret` replaces the stored value with MASK on the way out, and the
    // Studio's edit dialog put that string straight into its form field — so
    // saving a webhook after changing only its URL re-signed every future
    // delivery with the literal bullet characters, and every receiver's HMAC
    // check started failing, silently. `routes/settings.ts` has defended against
    // exactly this since secrets were masked there; this route had not.
    if (data.secret === MASK) {
      delete toSet.secret;
    } else if (typeof data.secret === 'string' && data.secret.length > 0) {
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
      .limit(paging(undefined, limit, 50, 500).limit)
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

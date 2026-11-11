import { CompiledQuery, sql } from 'kysely';
import type { Database } from '../db/index.js';
import { webhookDeliveries, webhookDeliveryDuration, webhookRetries } from './runtime/index.js';
import { validatePublicUrl, safeFetch } from './edge-functions/safe-fetch.js';
import {
  type JobQueue,
  jobQueue,
  maybeDecrypt,
  onJobQueueStart,
  principalRecord,
} from './data/index.js';
import { DEFAULT_TENANT_ID } from './route-db.js';
import { toJsonb } from './jsonb.js';
import { problem, ProblemException } from './problem.js';
import { asEngineRole } from './role-window.js';
import {
  rolePrincipal,
  runOutsideTenantContext,
  runWithDomain,
  withEveryTenant,
  withTenantIsolation,
} from './tenancy/index.js';

let _db: Database | null = null;

/**
 * What one subscription's role reads of a record (ADR 0004). Replaced only by
 * the canned-database unit tests, which have no Casbin to resolve a role with.
 */
let readAsRole = async (
  tenant: string,
  role: string,
  collection: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown> | null> =>
  principalRecord(
    _db as Database,
    collection,
    await runWithDomain(tenant, () => rolePrincipal(role)),
    record,
  );

/** Test-only: replace `readAsRole`; returns the restorer. */
export function _setReadAsRoleForTests(fn: typeof readAsRole): () => void {
  const previous = readAsRole;
  readAsRole = fn;
  return () => {
    readAsRole = previous;
  };
}

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

/** The pg-boss queue every webhook delivery is a job on (ADR 0035). */
export const WEBHOOK_QUEUE = 'webhook.deliver';

/**
 * A completed delivery's job is kept one hour, not the seven days of the DDL
 * queues: its payload is a record snapshot, and the delivery row already keeps
 * what was sent. Created and retrying jobs keep the 30 days of `QUEUE_RETENTION`
 * (a literal: `data/index.js` imports this module, so its binding is not yet set).
 */
export const WEBHOOK_QUEUE_RETENTION = {
  deleteAfterSeconds: 60 * 60,
  retentionSeconds: 30 * 24 * 60 * 60,
};

/** One delivery job's payload. Never the signing secret: it is read from the row at delivery. */
export interface WebhookJob {
  tenantId: string;
  webhookId: string;
  eventId: string;
  sequence: number;
  event: string;
  collection: string;
  /** The outbound record (no unserved, no sealed columns), before its role's view. */
  data: Record<string, unknown>;
  timestamp: string;
}

/** The change one write announces; `id` is the write's, the same for every subscriber. */
export interface ChangeEvent {
  id: string;
  event: string;
  collection: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// Created once per pg-boss instance, before the first send or work on it.
const queues = new WeakMap<JobQueue, Promise<void>>();
function ensureQueue(boss: JobQueue): Promise<void> {
  let ready = queues.get(boss);
  if (!ready) {
    ready = boss.createQueue(WEBHOOK_QUEUE, WEBHOOK_QUEUE_RETENTION).then(() => undefined);
    ready.catch(() => queues.delete(boss));
    queues.set(boss, ready);
  }
  return ready;
}

// One lookup per collection and event per transaction: a bulk write of 500 rows
// asks once.
const lookups = new WeakMap<
  object,
  Map<string, Promise<{ id: string; retry_attempts: number }[]>>
>();

const refuse = (why: string): never => {
  throw problem(
    'webhooks.enqueue_failed',
    503,
    `the write was not made: its webhook event could not be enqueued (${why})`,
  );
};

/**
 * Enqueue one `webhook.deliver` job per matching subscription, on the write's
 * own transaction (ADR 0035): the event commits with the row or not at all.
 * As the engine's role, as `host.enqueue` does: `zveltio_rls` holds nothing on
 * `pgboss`. No match takes no sequence value and needs no queue; a match with
 * no queue refuses the write.
 */
export async function enqueueWebhookEvent(
  db: Database,
  tenantId: string | null,
  change: ChangeEvent,
): Promise<void> {
  const tenant = tenantId ?? DEFAULT_TENANT_ID;
  const run = (trx: Database) => asEngineRole(trx, () => enqueueOn(trx, tenant, change));
  // Outside a transaction (a route that opens none) the row is already in; the
  // lookup still needs its firm to see past the tenant policy (migration 028).
  await (db.isTransaction ? run(db) : withTenantIsolation(tenant, run));
}

async function enqueueOn(trx: Database, tenant: string, change: ChangeEvent): Promise<void> {
  const key = `${tenant}\u0000${change.event}\u0000${change.collection}`;
  let byKey = lookups.get(trx);
  if (!byKey) {
    byKey = new Map();
    lookups.set(trx, byKey);
  }
  let found = byKey.get(key);
  if (!found) {
    found = sql<{ id: string; retry_attempts: number | null }>`
      SELECT id::text AS id, retry_attempts FROM zvd_webhooks
      WHERE active = true
        AND tenant_id = ${tenant}::uuid
        AND (events @> ARRAY[${change.event}]::text[] OR events @> ARRAY['*']::text[])
        AND (
          collections IS NULL
          OR cardinality(collections) = 0
          OR collections @> ARRAY[${change.collection}]::text[]
          OR collections @> ARRAY['*']::text[]
        )
    `
      .execute(trx)
      .then((r) => r.rows.map((h) => ({ id: h.id, retry_attempts: h.retry_attempts ?? 3 })));
    byKey.set(key, found);
  }
  const hooks = await found;
  if (hooks.length === 0) return;

  const boss = jobQueue();
  if (!boss) return refuse('the job queue is not running');
  try {
    await ensureQueue(boss);
    // After the row write, so two writes to one record (serialised by its lock)
    // take their values in commit order.
    const seq = await sql<{ n: string }>`
      SELECT nextval('zv_change_event_seq')::text AS n`.execute(trx);
    const sequence = Number(seq.rows[0]!.n);
    const ids = await boss.insert(
      WEBHOOK_QUEUE,
      hooks.map((h) => ({
        data: {
          tenantId: tenant,
          webhookId: h.id,
          eventId: change.id,
          sequence,
          event: change.event,
          collection: change.collection,
          data: change.data,
          timestamp: change.timestamp,
        } satisfies WebhookJob,
        retryLimit: h.retry_attempts,
        retryDelay: 1,
        retryBackoff: true,
      })),
      {
        returnId: true,
        db: {
          executeSql: (text, values) =>
            trx.executeQuery(CompiledQuery.raw(text, values ?? [])) as Promise<{ rows: never[] }>,
        },
      },
    );
    if (!ids || ids.length !== hooks.length) refuse('pg-boss inserted no job');
  } catch (err) {
    if (err instanceof ProblemException) throw err;
    refuse(err instanceof Error ? err.message : String(err));
  }
}

/** Queue a new delivery of a stored event on `trx` (`POST /dlq/replay`). */
export async function enqueueReplay(
  trx: Database,
  job: WebhookJob,
  retryLimit: number,
): Promise<void> {
  const boss = jobQueue();
  if (!boss) refuse('the job queue is not running');
  await ensureQueue(boss!);
  await asEngineRole(trx, () =>
    boss!.send(WEBHOOK_QUEUE, job as unknown as object, {
      retryLimit,
      retryDelay: 1,
      retryBackoff: true,
      db: {
        executeSql: (text, values) =>
          trx.executeQuery(CompiledQuery.raw(text, values ?? [])) as Promise<{ rows: never[] }>,
      },
    }),
  );
}

/** A pg-boss job of the delivery queue, with the retry count it is on. */
type DeliverJob = { id: string; data: WebhookJob; retryCount: number; retryLimit: number };

/**
 * Run one delivery. Reads the webhook again as its firm (gone or inactive:
 * nothing to deliver), reads the record as the webhook's role (ADR 0004; a
 * record that role may not read is not announced), signs with the secret read
 * from the row, POSTs. A failed POST throws, so pg-boss retries it with backoff
 * up to the webhook's `retry_attempts`; the delivery row records each outcome.
 */
export async function runWebhookJob(job: DeliverJob): Promise<void> {
  const d = job.data;
  const wh = await withTenantIsolation(d.tenantId, (trx) =>
    trx
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('id', '=', d.webhookId)
      .where('tenant_id', '=', d.tenantId)
      .executeTakeFirst(),
  );
  if (!wh || !wh.active || !wh.run_as_role) return;
  if (!_db) throw new Error('[webhooks] not initialised');
  const record = await readAsRole(d.tenantId, wh.run_as_role, d.collection, d.data);
  if (!record) return;

  const delivered = await withTenantIsolation(d.tenantId, (trx) =>
    trx
      .selectFrom('zvd_webhook_deliveries')
      .select('id')
      .where('webhook_id', '=', d.webhookId)
      .where('event_id', '=', d.eventId)
      .where('delivered_at', 'is not', null)
      .executeTakeFirst(),
  );
  // Delivered before, by a run whose completion was lost: once is enough.
  if (delivered) return;

  let secret: string | null = null;
  if (wh.secret) {
    const plain = await maybeDecrypt(wh.secret, true);
    secret = typeof plain === 'string' ? plain : null;
  }
  const envelope = {
    id: d.eventId,
    sequence: d.sequence,
    event: d.event,
    collection: d.collection,
    data: record,
    timestamp: d.timestamp,
  };
  const headers = (wh.headers as Record<string, string> | null) ?? {};
  const started = performance.now();
  const outcome = await WebhookManager.deliver({
    ...envelope,
    url: wh.url,
    method: wh.method || 'POST',
    headers,
    secret,
    timeout: wh.timeout || 5000,
  });
  webhookDeliveryDuration.observe({}, (performance.now() - started) / 1000);
  webhookDeliveries.inc({ status: outcome.ok ? 'success' : 'failed' });

  const row = {
    payload: toJsonb(envelope),
    url: wh.url,
    method: wh.method || 'POST',
    headers: toJsonb(headers),
    attempt: job.retryCount + 1,
    max_attempts: job.retryLimit,
    status: outcome.status,
    response_body: outcome.responseBody,
    error: outcome.error,
    delivered_at: outcome.ok ? new Date() : null,
  };
  // One row per event and webhook, however often the job runs.
  await withTenantIsolation(d.tenantId, (trx) =>
    trx
      .insertInto('zvd_webhook_deliveries')
      .values({
        ...row,
        webhook_id: d.webhookId,
        event_id: d.eventId,
        tenant_id: d.tenantId,
      } as never)
      .onConflict((oc) => oc.columns(['webhook_id', 'event_id']).doUpdateSet(row as never))
      .execute(),
  );
  if (!outcome.ok) {
    if (job.retryCount < job.retryLimit) webhookRetries.inc({});
    else {
      console.error(
        `[webhooks] giving up on ${d.event} → ${wh.url} after ${job.retryCount + 1} attempt(s); ` +
          'it is listed in GET /api/webhooks/dlq',
      );
    }
    throw new Error(
      `webhook ${d.webhookId}: delivery failed (${outcome.error ?? `HTTP ${outcome.status}`})`,
    );
  }
}

/** Work the delivery queue on this instance. Boot only; tests run jobs with `_runWebhookJobs`. */
export function startWebhookWorker(): void {
  onJobQueueStart(async (boss) => {
    await ensureQueue(boss);
    // Outside whatever context pg-boss resumes its loop in (see ddl-queue's `work`).
    // Ten at once and a 1 s poll, as the old cache worker did: one slow endpoint
    // (up to its 30 s timeout) must not hold every other delivery behind it.
    const options = {
      includeMetadata: true,
      localConcurrency: 10,
      pollingIntervalSeconds: 1,
      // A backlog is fetched without that pause, which caps a worker at one job per poll.
      burstWhenReadyExceeds: 10,
    } as const;
    await boss.work<WebhookJob, void, typeof options>(WEBHOOK_QUEUE, options, ([j]) =>
      runOutsideTenantContext(() => runWebhookJob(j!)),
    );
  });
}

/**
 * Test-only: claim every due delivery job and run it as the worker would, until
 * none is due. Claimed through pg-boss, so a failure is retried by pg-boss's
 * own rules and a job runs once per claim.
 */
export async function _runWebhookJobs(): Promise<number> {
  const boss = jobQueue();
  if (!boss) return 0;
  await ensureQueue(boss);
  let ran = 0;
  for (;;) {
    const jobs = await boss.fetch<WebhookJob>(WEBHOOK_QUEUE, {
      batchSize: 50,
      includeMetadata: true,
    });
    if (jobs.length === 0) return ran;
    for (const j of jobs) {
      ran++;
      await runOutsideTenantContext(() => runWebhookJob(j)).then(
        () => boss.complete(WEBHOOK_QUEUE, j.id),
        (err: Error) => boss.fail(WEBHOOK_QUEUE, j.id, { message: err.message }),
      );
    }
  }
}

/** What one POST came to, as the delivery row records it. */
export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  responseBody: string | null;
  error: string | null;
}

/** One delivery's envelope and target, as `deliver` sends it. */
export interface DeliveryPayload {
  id: string;
  sequence: number;
  event: string;
  collection: string;
  data: unknown;
  timestamp: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  secret?: string | null;
  timeout?: number;
}

export const WebhookManager = {
  init(db: Database): void {
    _db = db;
  },

  async deliver(payload: DeliveryPayload): Promise<DeliveryOutcome> {
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let ok = false;

    try {
      const body = JSON.stringify({
        id: payload.id,
        sequence: payload.sequence,
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

    return { ok, status: httpStatus, responseBody, error: errorMessage };
  },
};

/**
 * Cross-instance realtime bus.
 *
 * Abstracts away "how do other engine replicas hear about my writes?" so
 * the rest of the codebase only sees `realtimeBus.publish(payload)`.
 * Two pluggable backends, selected at bootstrap by env:
 *
 *   - **ValkeyRealtimeBus** (preferred when `VALKEY_URL` is set): Valkey/Redis
 *     PUB/SUB on the channel `zveltio:realtime`. Lower latency than
 *     pg_notify, no 8KB payload limit, and keeps Postgres free for actual
 *     queries. Recommended for >2 engine replicas.
 *
 *   - **PgNotifyRealtimeBus** (default when no Valkey is configured): uses
 *     Postgres LISTEN/NOTIFY on a dedicated node-postgres connection (`Bun.SQL`
 *     has no LISTEN). Zero new infrastructure. Fine for ≤2 replicas and the
 *     self-hosted single-box case. LISTEN needs a session, so it connects to
 *     `NATIVE_DATABASE_URL` when set, past a transaction pooler.
 *
 * Both backends translate received payloads into `broadcastEvent(...)`
 * calls into `routes/ws.ts`, which fans out to the local WS subscribers.
 *
 * One important property: the publishing instance does NOT receive its
 * own message back through the bus. The `data.ts` write path already
 * calls `broadcastEvent` locally before publishing. If the bus echoed,
 * local WS clients would see duplicate events. Both backends are
 * configured to suppress self-echo:
 *   - Valkey: tagged with `originId` (per-process random); the subscriber
 *     drops messages with its own originId.
 *   - pg_notify: each instance LISTENs on the same channel; Postgres
 *     delivers to all subscribers including the sender, so we apply the
 *     same originId filter.
 */

import Redis from 'ioredis';
import pg from 'pg';
import { broadcastDataEvent } from '../../routes/realtime.js';
import { broadcastEvent, broadcastSchemaChange } from '../../routes/ws.js';

const CHANNEL_NAME = 'zveltio:realtime';
const PG_NOTIFY_CHANNEL = 'zveltio_changes';

/** Postgres pg_notify payload limit is 8000 bytes — stay under it. */
export const PG_NOTIFY_PAYLOAD_MAX = 7900;

/**
 * A Casbin policy write on another instance (`lib/tenancy/permissions.ts`).
 * Not a record event: it goes to the enforcer, never to a subscriber.
 */
export const POLICY_CHANGED_EVENT = 'casbin.policy';

/**
 * A row rule or column permission changed on another instance. Carries no
 * rules: the receiver re-resolves its open subscriptions from the table, so a
 * forged message can only cause a sweep.
 */
export const ACCESS_RULES_CHANGED_EVENT = 'access.rules';

/**
 * A `zv_rate_limit_configs` row changed on another instance. Names the key (or
 * none: all of them); the receiver drops its cached copy and re-reads the table.
 */
export const RATE_LIMIT_CONFIG_CHANGED_EVENT = 'ratelimit.config';

/**
 * A collection was created, altered or dropped on another instance. `data` is
 * `{ action }`; the receiver hands it to its own schema-channel subscribers.
 */
export const SCHEMA_CHANGED_EVENT = 'schema.changed';

/**
 * An extension's credential-forwarding approval changed on another instance.
 * `collection` is the extension name; the receiver re-reads the approval and
 * restarts its worker if what it forwards changed.
 */
export const EXTENSION_FORWARD_CHANGED_EVENT = 'extension.forward';

/**
 * An extension was enabled, disabled or uninstalled on another instance.
 * `collection` is the extension name. Carries no state: the receiver re-reads
 * the registry and loads or unloads its own copy to match (its migrations
 * already ran there), so a forged message can only cause a re-read.
 */
export const EXTENSION_LIFECYCLE_EVENT = 'extension.lifecycle';

/** Tell the other instances `name`'s registry row changed. After the write, never before. */
export function announceExtensionLifecycle(name: string): void {
  realtimeBus()
    .publish({
      event: EXTENSION_LIFECYCLE_EVENT,
      collection: name,
      timestamp: new Date().toISOString(),
    })
    .catch((err: Error) => {
      console.error(`[realtime-bus] ${name}: lifecycle change not announced:`, err.message);
    });
}

/**
 * An extension's own message (`ctx.broadcast`, `lib/extensions/broadcast.ts`).
 * `collection` is the extension that sent it, `data` is `{ name, data }`; the
 * receiver runs that extension's handlers for `name` and nobody else's.
 */
export const EXTENSION_BROADCAST_EVENT = 'extension.broadcast';

/**
 * An extension migration or purge reshaped tables on another instance. Every
 * pooled connection here that prepared a `SELECT *` over one of them answers it
 * with `0A000` — a 500 inside a request transaction — until it is replaced, so
 * the receiver recycles its pool (`recycleActivePool`). Carries nothing.
 */
export const POOL_RECYCLE_EVENT = 'db.pool.recycle';

/** A burst (enable-all migrates several extensions) costs one recycle, not one each. */
const POOL_RECYCLE_COALESCE_MS = 500;
let pendingRecycle: Promise<void> | null = null;

function recyclePoolSoon(): Promise<void> {
  pendingRecycle ??= Bun.sleep(POOL_RECYCLE_COALESCE_MS)
    .then(() => {
      // Cleared before the recycle: a reshape announced while it runs is newer
      // than what this one drops, and gets its own.
      pendingRecycle = null;
      return import('../../db/index.js');
    })
    .then((m) => m.recycleActivePool())
    .catch((err: Error) => {
      console.error('[realtime-bus] pool recycle not applied:', err.message);
    });
  return pendingRecycle;
}

/** An announcement made before the bus could carry it (boot runs extension migrations alongside its start). */
let recycleOwed = false;

/**
 * Tell the other instances to recycle their pools, after this one ran DDL that
 * stales prepared plans. Boot loads extensions in parallel with starting the
 * bus, so one made too early is kept and sent once the bus is up.
 */
export function announcePoolRecycle(): void {
  const bus = realtimeBus();
  if (!bus.isHealthy()) {
    recycleOwed = true;
    return;
  }
  bus
    .publish({ event: POOL_RECYCLE_EVENT, collection: '', timestamp: new Date().toISOString() })
    .catch((err: Error) => {
      console.error('[realtime-bus] pool recycle not announced:', err.message);
    });
}

function sendOwedRecycle(): void {
  if (!recycleOwed) return;
  recycleOwed = false;
  announcePoolRecycle();
}

// Per-process origin id so we can filter our own echoed messages.
export const ORIGIN_ID = `eng-${crypto.randomUUID().slice(0, 8)}`;

export interface RealtimeBusMessage {
  /** Originator's process id; bus filters echoes by matching this. */
  originId: string;
  /** Engine event name: `record.created` / `record.updated` / `record.deleted`, or `POLICY_CHANGED_EVENT`. */
  event: string;
  /** Collection name without the `zvd_` prefix. */
  collection: string;
  /** Record id when known. */
  record_id?: string;
  /** Full record body for downstream consumers. */
  data?: unknown;
  /** RFC 3339. */
  timestamp: string;
  /**
   * Tenant id of the write. Required for multi-tenant cross-instance
   * fan-out: without it the receiving engine has no way to know which
   * tenant's subscribers should receive the message and would deliver
   * to every same-collection subscriber across all tenants.
   * `null` for single-tenant deployments.
   */
  tenantId?: string | null;
}

export interface RealtimeBus {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Publish a write event to other engine instances. The local instance
   * already called `broadcastEvent` directly — this is only the
   * cross-instance fan-out.
   */
  publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void>;
  readonly isRunning: boolean;
  /** True when the backend is ready to fan out cross-instance events. */
  isHealthy(): boolean;
  readonly backend: 'valkey' | 'pg-notify' | 'none';
}

/** Parametrized pg_notify — no SQL string concatenation. */
export type PgNotifyPublisher = {
  notify: (channel: string, payload: string) => Promise<unknown>;
};

/**
 * Encoded size of a bus message in BYTES.
 *
 * `String.length` counts UTF-16 code units and pg_notify's cap is in UTF-8
 * bytes, so the two disagree on every non-ASCII character — `JSON.stringify`
 * emits `\u0103` as the literal `\u{103}`, not an escape. A record of Romanian
 * text runs ~12% larger in bytes than in code units, which clears the 1.27%
 * of headroom PG_NOTIFY_PAYLOAD_MAX leaves under the 8000-byte cap. Measured
 * the wrong way, a ~7.5KB record passes this guard and is then rejected by
 * Postgres.
 */
function encodedBytes(msg: RealtimeBusMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8');
}

/**
 * Shrink a bus message to fit pg_notify's 8KB cap. Receivers fall back to
 * `{ id: record_id }` when `data` is absent (`dispatchToWs`), and a policy
 * change without its rules re-reads the policy table.
 *
 * One step, not two: dropping `data` leaves only ids, a collection name and a
 * timestamp, which is bounded at a few hundred bytes and always fits. The
 * previous third tier rebuilt exactly the object `{ ...full, data: undefined }`
 * already encodes to — `JSON.stringify` omits undefined values — so it could
 * never be reached.
 */
export function trimForPgNotify(payload: Omit<RealtimeBusMessage, 'originId'>): RealtimeBusMessage {
  const full: RealtimeBusMessage = { ...payload, originId: ORIGIN_ID };
  if (encodedBytes(full) <= PG_NOTIFY_PAYLOAD_MAX) return full;
  return { ...full, data: undefined };
}

// ── Event mapping (shared by both backends) ─────────────────────────────────

const EVENT_MAP: Record<string, 'insert' | 'update' | 'delete'> = {
  'record.created': 'insert',
  'record.updated': 'update',
  'record.deleted': 'delete',
};

/**
 * Hand an inbound bus message to the local subscribers — BOTH doors.
 *
 * It used to call `broadcastEvent` alone, which is the WebSocket fan-out. The
 * SSE stream keeps its own Valkey subscription to `zveltio:data:<collection>`,
 * but nothing in the engine publishes to those channels, so on a deployment
 * with two replicas an SSE client saw only the writes made by the replica it
 * happened to be connected to. Measured with a stream open: a `record.created`
 * arriving from another replica delivered nothing at all.
 *
 * `broadcastDataEvent` applies the subscriber's row policies and column
 * permissions, so a cross-instance event is filtered exactly like a local one.
 */
function dispatchToWs(msg: RealtimeBusMessage): void | Promise<void> {
  if (msg.originId === ORIGIN_ID) return; // own echo
  if (msg.event === POLICY_CHANGED_EVENT) {
    // Imported lazily: tenancy imports this module, and the change is rare.
    return import('../tenancy/index.js')
      .then(async (m) => {
        // No rules: `trimForPgNotify` dropped them over the 8 KB cap — re-read the table.
        if (msg.data === undefined) await m.reconcilePolicies();
        else await m.receivePolicyChange(msg.data);
      })
      .catch((err: Error) => {
        console.error('[realtime-bus] policy change not applied:', err.message);
      });
  }
  if (msg.event === ACCESS_RULES_CHANGED_EVENT) {
    const { userId, scope } = (msg.data ?? {}) as { userId?: unknown; scope?: unknown };
    return import('../tenancy/index.js')
      .then((m) => {
        // A user's own row changed: drop what this instance remembers of them.
        if (typeof userId === 'string' && userId) m.clearLocalPermissionCache(userId);
        // A revoked session or key: re-ask only who each connection is.
        m.revalidateSockets(scope === 'principals' ? 'principals' : 'all');
      })
      .catch((err: Error) => {
        console.error('[realtime-bus] rule change sweep not started:', err.message);
      });
  }
  if (msg.event === RATE_LIMIT_CONFIG_CHANGED_EVENT) {
    const keyPrefix = (msg.data as { keyPrefix?: unknown } | undefined)?.keyPrefix;
    // Lazily, like tenancy above: the middleware imports this module.
    return import('../../middleware/rate-limit.js')
      .then((m) =>
        m.clearLocalRateLimitCache(typeof keyPrefix === 'string' ? keyPrefix : undefined),
      )
      .catch((err: Error) => {
        console.error('[realtime-bus] rate-limit config change not applied:', err.message);
      });
  }
  if (msg.event === EXTENSION_FORWARD_CHANGED_EVENT) {
    if (!msg.collection) return;
    // Lazily: the extensions subsystem imports this module.
    return Promise.all([import('../extensions/index.js'), import('../../db/index.js')])
      .then(([ext, d]) => ext.refreshForwardApproval(d.getDb(), [msg.collection]))
      .catch((err: Error) => {
        console.error('[realtime-bus] forward approval change not applied:', err.message);
      });
  }
  if (msg.event === EXTENSION_LIFECYCLE_EVENT) {
    if (!msg.collection) return;
    return import('../extensions/index.js')
      .then(async (m) => {
        await m.extensionLoader.syncWithRegistry(msg.collection);
      })
      .catch((err: Error) => {
        console.error(
          `[realtime-bus] ${msg.collection}: lifecycle change not applied:`,
          err.message,
        );
      });
  }
  if (msg.event === EXTENSION_BROADCAST_EVENT) {
    return import('../extensions/index.js')
      .then((m) => m.receiveExtensionBroadcast(msg))
      .catch((err: Error) => {
        console.error(`[realtime-bus] ${msg.collection}: broadcast not delivered:`, err.message);
      });
  }
  if (msg.event === POOL_RECYCLE_EVENT) return recyclePoolSoon();
  if (msg.event === SCHEMA_CHANGED_EVENT) {
    const action = (msg.data as { action?: unknown } | undefined)?.action;
    if (msg.collection && (action === 'create' || action === 'alter' || action === 'drop'))
      broadcastSchemaChange(msg.collection, action);
    return;
  }
  const wsEvent = EVENT_MAP[msg.event];
  if (!wsEvent) return;
  if (!msg.collection) return;
  const data = msg.data ?? { id: msg.record_id };
  broadcastEvent(msg.collection, wsEvent, data, msg.tenantId ?? null);
  broadcastDataEvent(msg.collection, wsEvent, data, msg.tenantId ?? null);
}

/**
 * Messages published while this subscriber was away are gone, so catch up on
 * the policy table rather than wait for the next reconcile tick — and re-check
 * open subscriptions, for a row or column rule change missed meanwhile.
 */
function onBusReconnected(): void {
  // A migration announced meanwhile left this pool's plans stale.
  void recyclePoolSoon();
  // Rate-limit config changes missed meanwhile: drop every cached limit, so the
  // next request reads the table instead of waiting out the TTL.
  import('../../middleware/rate-limit.js')
    .then((m) => m.clearLocalRateLimitCache())
    .catch((err: Error) => {
      console.error('[realtime-bus] rate-limit cache clear after reconnect failed:', err.message);
    });
  // A missed forward-approval change, a withdrawal above all: re-read them all.
  Promise.all([import('../extensions/index.js'), import('../../db/index.js')])
    .then(([ext, d]) => ext.refreshForwardApproval(d.getDb()))
    .catch((err: Error) => {
      console.error('[realtime-bus] forward approval resync after reconnect failed:', err.message);
    });
  // An extension enabled or disabled elsewhere meanwhile, and its own messages
  // sent meanwhile: each extension drops what they would have refreshed.
  import('../extensions/index.js')
    .then((m) =>
      Promise.all([m.extensionLoader.syncAllWithRegistry(), m.extensionBroadcastsMissed()]),
    )
    .catch((err: Error) => {
      console.error('[realtime-bus] extension resync after reconnect failed:', err.message);
    });
  import('../tenancy/index.js')
    .then((m) => {
      m.revalidateSockets();
      return m.reconcilePolicies();
    })
    .catch((err: Error) => {
      console.error('[realtime-bus] policy reconcile after reconnect failed:', err.message);
    });
}

function attachIoredisErrorHandler(client: Redis, label: string): void {
  client.on('error', (err: Error) => {
    console.error(`[realtime-bus] Valkey ${label} error:`, err.message);
  });
}

// ── Valkey backend ──────────────────────────────────────────────────────────

class ValkeyRealtimeBus implements RealtimeBus {
  readonly backend = 'valkey' as const;
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private _running = false;

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    if (this._running) return;
    this.subscriber = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(100 * 2 ** times, 1000) + Math.random() * 100,
    });
    this.publisher = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(100 * 2 ** times, 1000) + Math.random() * 100,
    });
    attachIoredisErrorHandler(this.subscriber, 'subscriber');
    attachIoredisErrorHandler(this.publisher, 'publisher');
    await this.subscriber.connect();
    await this.publisher.connect();

    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL_NAME) return;
      let msg: RealtimeBusMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      dispatchToWs(msg);
    });
    await this.subscriber.subscribe(CHANNEL_NAME);
    // `ready` fires again on every reconnect (ioredis resubscribes by itself).
    this.subscriber.on('ready', onBusReconnected);
    this._running = true;
    sendOwedRecycle();
    console.log(`✅ Realtime bus: Valkey PUB/SUB on ${CHANNEL_NAME} (origin=${ORIGIN_ID})`);
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(CHANNEL_NAME);
      } catch {
        /* */
      }
      try {
        await this.subscriber.quit();
      } catch {
        /* */
      }
      this.subscriber = null;
    }
    if (this.publisher) {
      try {
        await this.publisher.quit();
      } catch {
        /* */
      }
      this.publisher = null;
    }
    this._running = false;
  }

  async publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    if (!this.publisher) return;
    const msg: RealtimeBusMessage = { ...payload, originId: ORIGIN_ID };
    await this.publisher.publish(CHANNEL_NAME, JSON.stringify(msg));
  }

  get isRunning(): boolean {
    return this._running;
  }

  isHealthy(): boolean {
    return this._running;
  }
}

// ── pg_notify backend ───────────────────────────────────────────────────────

class PgNotifyRealtimeBus implements RealtimeBus {
  readonly backend = 'pg-notify' as const;
  /** LISTEN's own connection, outside the pool: a pool recycle must not drop it. */
  private client: pg.Client | null = null;
  private _running = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  /** The engine pool by default: LISTEN's own connection is not for publishing. */
  private publisher: PgNotifyPublisher = {
    notify: async (channel, payload) => {
      const [{ sql }, { getDb }] = await Promise.all([
        import('kysely'),
        import('../../db/index.js'),
      ]);
      return sql`SELECT pg_notify(${channel}, ${payload})`.execute(getDb());
    },
  };
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly databaseUrl: string) {}

  setPublisher(executor: PgNotifyPublisher): void {
    this.publisher = executor;
  }

  /** Only the current connection's loss counts; a replaced one's late `end` does not. */
  private lost(client: pg.Client, reason: string): void {
    if (client !== this.client) return;
    this.client = null;
    this.stopHeartbeat();
    client.end().catch(() => {});
    this.scheduleListenReconnect(reason);
  }

  private scheduleListenReconnect(reason: string): void {
    if (this.stopping || this.retryTimer) return;
    this._running = false;
    // Capped at 30 s: every NOTIFY sent while down is lost, and the resync on
    // return covers them only once it runs.
    const delay = Math.min(1_000 * 2 ** this.retryAttempt, 30_000);
    this.retryAttempt++;
    console.warn(
      `[realtime-bus] LISTEN lost (${reason}), reconnecting in ${delay}ms (attempt ${this.retryAttempt})`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
  }

  async start(): Promise<void> {
    if (this.client || this.stopping) return; // connected, or connecting
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      application_name: 'zveltio-realtime-bus',
      connectionTimeoutMillis: 10_000,
      // A half-open socket (a partition, a dead host) emits nothing otherwise;
      // TCP probes find it within the OS's probe interval × count.
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      // Bounds the heartbeat below: a query on a half-open socket never answers.
      query_timeout: 10_000,
    });
    this.client = client;
    client.on('notification', (n) => {
      if (n.channel !== PG_NOTIFY_CHANNEL || !n.payload) return;
      let msg: RealtimeBusMessage;
      try {
        msg = JSON.parse(n.payload);
      } catch {
        return;
      }
      void dispatchToWs(msg);
    });
    // Without an `error` listener, a dropped connection throws out of the process.
    client.on('error', (err: Error) => this.lost(client, err.message));
    client.on('end', () => this.lost(client, 'end'));
    try {
      await client.connect();
      await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
    } catch (err) {
      this.lost(client, (err as Error).message);
      return;
    }
    if (client !== this.client) return; // stopped meanwhile
    this._running = true;
    // TCP keepalive alone finds a half-open socket only after the OS's probes
    // (minutes); every NOTIFY in that window is lost. A SELECT 1 that does not
    // answer within query_timeout ends the connection, and the reconnect resyncs.
    this.heartbeat = setInterval(() => {
      client
        .query('SELECT 1')
        .catch((err: Error) => this.lost(client, `heartbeat: ${err.message}`));
    }, 30_000);
    this.heartbeat.unref?.();
    if (this.retryAttempt > 0) onBusReconnected();
    this.retryAttempt = 0;
    sendOwedRecycle();
    console.log(`✅ Realtime bus: pg_notify LISTEN on ${PG_NOTIFY_CHANNEL} (origin=${ORIGIN_ID})`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.stopHeartbeat();
    if (client) await client.end().catch(() => {});
    this._running = false;
    this.retryAttempt = 0;
    this.stopping = false;
  }

  async publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    const msg = trimForPgNotify(payload);
    const encoded = JSON.stringify(msg);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > PG_NOTIFY_PAYLOAD_MAX) {
      console.error(
        `[realtime-bus] pg_notify payload still ${bytes} bytes after trim — dropping cross-instance fan-out`,
      );
      return;
    }
    // Log only. This does NOT reconnect the subscriber: publishing goes through
    // the injected executor's pool while LISTEN holds its own connection, so a
    // failure here says nothing about the subscription's health. Tearing it down on a publish error let one oversized payload —
    // a data condition, and a repeating one — knock out a working LISTEN and
    // blank realtime for the length of the backoff. Connection loss on the
    // subscriber is what the client's `error`/`end` handlers are for.
    await this.publisher.notify(PG_NOTIFY_CHANNEL, encoded).catch((err: Error) => {
      console.error('[realtime-bus] pg_notify failed:', err.message);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  get isRunning(): boolean {
    return this._running;
  }

  isHealthy(): boolean {
    return this._running && this.publisher !== null;
  }
}

// ── Null backend (no cross-instance) ────────────────────────────────────────

class NoopRealtimeBus implements RealtimeBus {
  readonly backend = 'none' as const;
  readonly isRunning = false;
  async start(): Promise<void> {
    /* nothing to do */
  }
  async stop(): Promise<void> {
    /* nothing to do */
  }
  async publish(_payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    /* discard */
  }
  isHealthy(): boolean {
    return true;
  }
}

// ── Public singleton ───────────────────────────────────────────────────────

function pickBus(): RealtimeBus {
  const databaseUrl = process.env.NATIVE_DATABASE_URL || process.env.DATABASE_URL;
  if (process.env.VALKEY_URL) return new ValkeyRealtimeBus(process.env.VALKEY_URL);
  if (databaseUrl) return new PgNotifyRealtimeBus(databaseUrl);
  return new NoopRealtimeBus();
}

let _instance: RealtimeBus | null = null;
export function realtimeBus(): RealtimeBus {
  if (!_instance) _instance = pickBus();
  return _instance;
}

export function _resetForTests(): void {
  _instance = null;
}

export const _ORIGIN_ID = ORIGIN_ID;

export { ValkeyRealtimeBus, PgNotifyRealtimeBus, NoopRealtimeBus, dispatchToWs };

/** Test-only export — never import outside src/tests/. */
export const _internalForTests = { onBusReconnected };

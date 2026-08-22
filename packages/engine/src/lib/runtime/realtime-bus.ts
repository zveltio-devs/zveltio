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
 *     Postgres LISTEN/NOTIFY via `Bun.SQL.subscribe()`. Zero new
 *     infrastructure. Fine for ≤2 replicas and the self-hosted single-box
 *     case.
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
import { broadcastEvent } from '../../routes/ws.js';

const CHANNEL_NAME = 'zveltio:realtime';
const PG_NOTIFY_CHANNEL = 'zveltio_changes';

/** Postgres pg_notify payload limit is 8000 bytes — stay under it. */
export const PG_NOTIFY_PAYLOAD_MAX = 7900;

// Per-process origin id so we can filter our own echoed messages.
const ORIGIN_ID = `eng-${crypto.randomUUID().slice(0, 8)}`;

export interface RealtimeBusMessage {
  /** Originator's process id; bus filters echoes by matching this. */
  originId: string;
  /** Engine event name. Today: `record.created` / `record.updated` / `record.deleted`. */
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
 * `{ id: record_id }` when `data` is absent (`dispatchToWs`).
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

function dispatchToWs(msg: RealtimeBusMessage): void {
  if (msg.originId === ORIGIN_ID) return; // own echo
  const wsEvent = EVENT_MAP[msg.event];
  if (!wsEvent) return;
  if (!msg.collection) return;
  broadcastEvent(msg.collection, wsEvent, msg.data ?? { id: msg.record_id }, msg.tenantId ?? null);
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
    this._running = true;
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
  // @ts-ignore — BunSubscription typed by bun-types
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  private subscription: any | null = null;
  private _running = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private publisher: PgNotifyPublisher | null = null;

  constructor(private readonly databaseUrl: string) {}

  setPublisher(executor: PgNotifyPublisher): void {
    this.publisher = executor;
  }

  private attachSubscriptionHandlers(): void {
    const sub = this.subscription;
    if (!sub || typeof sub !== 'object') return;
    if (typeof sub.on === 'function') {
      sub.on('error', (err: Error) => this.scheduleListenReconnect(err?.message ?? 'error'));
      sub.on('close', () => this.scheduleListenReconnect('close'));
      sub.on('end', () => this.scheduleListenReconnect('end'));
    }
  }

  private scheduleListenReconnect(reason: string): void {
    if (this.stopping || this.retryTimer) return;
    this._running = false;
    const delay = Math.min(1_000 * 2 ** this.retryAttempt, 300_000);
    this.retryAttempt++;
    console.warn(
      `[realtime-bus] LISTEN lost (${reason}), reconnecting in ${delay}ms (attempt ${this.retryAttempt})`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconnectListen();
    }, delay);
  }

  private async reconnectListen(): Promise<void> {
    if (this.stopping) return;
    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
      } catch {
        /* */
      }
      this.subscription = null;
    }
    await this.start();
  }

  async start(): Promise<void> {
    if (this._running) return;
    try {
      // @ts-ignore — Bun.SQL global typed by bun-types
      const sql = new Bun.SQL(this.databaseUrl);
      // @ts-ignore — Bun.SQL.subscribe runtime-only
      this.subscription = await sql.subscribe(PG_NOTIFY_CHANNEL, (raw: string) => {
        let msg: RealtimeBusMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        dispatchToWs(msg);
      });
      this.attachSubscriptionHandlers();
      this._running = true;
      this.retryAttempt = 0;
      console.log(
        `✅ Realtime bus: pg_notify LISTEN on ${PG_NOTIFY_CHANNEL} (origin=${ORIGIN_ID})`,
      );
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      if (err.message?.includes('is not a function')) {
        console.warn('[realtime-bus] LISTEN/NOTIFY not available — single-instance only.');
        return;
      }
      this.scheduleListenReconnect(err.message ?? 'start failed');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
      } catch {
        /* */
      }
      this.subscription = null;
    }
    this._running = false;
    this.retryAttempt = 0;
    this.stopping = false;
  }

  async publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    if (!this.publisher) return;
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
    // the injected executor's pool while LISTEN holds its own `Bun.SQL`
    // connection, so a failure here says nothing about the subscription's
    // health. Tearing it down on a publish error let one oversized payload —
    // a data condition, and a repeating one — knock out a working LISTEN and
    // blank realtime for the length of the backoff. Connection loss on the
    // subscriber is what `attachSubscriptionHandlers` is for.
    await this.publisher.notify(PG_NOTIFY_CHANNEL, encoded).catch((err: Error) => {
      console.error('[realtime-bus] pg_notify failed:', err.message);
    });
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
  const databaseUrl = process.env.DATABASE_URL;
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

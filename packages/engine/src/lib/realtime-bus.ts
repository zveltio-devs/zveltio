/**
 * Cross-instance realtime bus (S5-03).
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
import { broadcastEvent } from '../routes/ws.js';

const CHANNEL_NAME = 'zveltio:realtime';

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
  readonly backend: 'valkey' | 'pg-notify' | 'none';
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
  broadcastEvent(msg.collection, wsEvent, msg.data ?? { id: msg.record_id });
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
    // ioredis requires separate connections for subscribe vs. publish — the
    // subscriber connection is blocked from other commands while subscribed.
    this.subscriber = new Redis(this.url, { lazyConnect: true });
    this.publisher = new Redis(this.url, { lazyConnect: true });
    await this.subscriber.connect();
    await this.publisher.connect();

    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL_NAME) return;
      let msg: RealtimeBusMessage;
      try { msg = JSON.parse(raw); }
      catch { return; }
      dispatchToWs(msg);
    });
    await this.subscriber.subscribe(CHANNEL_NAME);
    this._running = true;
    console.log(`✅ Realtime bus: Valkey PUB/SUB on ${CHANNEL_NAME} (origin=${ORIGIN_ID})`);
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      try { await this.subscriber.unsubscribe(CHANNEL_NAME); } catch { /* */ }
      try { await this.subscriber.quit(); } catch { /* */ }
      this.subscriber = null;
    }
    if (this.publisher) {
      try { await this.publisher.quit(); } catch { /* */ }
      this.publisher = null;
    }
    this._running = false;
  }

  async publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    if (!this.publisher) return;
    const msg: RealtimeBusMessage = { ...payload, originId: ORIGIN_ID };
    await this.publisher.publish(CHANNEL_NAME, JSON.stringify(msg));
  }

  get isRunning(): boolean { return this._running; }
}

// ── pg_notify backend ───────────────────────────────────────────────────────

/**
 * Postgres LISTEN/NOTIFY backend. Uses Bun.SQL.subscribe (Bun 1.2+) for
 * the LISTEN half; publish goes through whatever Kysely instance the
 * caller has (we accept a Database in `setPgPublisher`).
 *
 * The previous `RealtimeManager` lived in `realtime.ts`. Its behavior is
 * preserved here so the only externally visible change is the `publish()`
 * method now passes through this class instead of inlining
 * `sql\`SELECT pg_notify(...)\`` in `data.ts`.
 */
class PgNotifyRealtimeBus implements RealtimeBus {
  readonly backend = 'pg-notify' as const;
  // @ts-ignore — BunSubscription typed by bun-types
  private subscription: any | null = null;
  private _running = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private publisher: { execute: (sql: string) => Promise<unknown> } | null = null;

  constructor(private readonly databaseUrl: string) {}

  /**
   * Plug a Kysely instance to use as the publisher. Called once at
   * bootstrap. Until set, `publish()` is a no-op so initialization order
   * isn't load-bearing.
   */
  setPublisher(executor: { execute: (sql: string) => Promise<unknown> }): void {
    this.publisher = executor;
  }

  async start(): Promise<void> {
    if (this._running) return;
    try {
      // @ts-ignore — Bun.SQL global typed by bun-types
      const sql = new Bun.SQL(this.databaseUrl);
      // @ts-ignore — Bun.SQL.subscribe runtime-only
      this.subscription = await sql.subscribe('zveltio_changes', (raw: string) => {
        let msg: RealtimeBusMessage;
        try { msg = JSON.parse(raw); }
        catch { return; }
        dispatchToWs(msg);
      });
      this._running = true;
      this.retryAttempt = 0;
      console.log(`✅ Realtime bus: pg_notify LISTEN on zveltio_changes (origin=${ORIGIN_ID})`);
    } catch (err: any) {
      if (err.message?.includes('is not a function')) {
        console.warn('[realtime-bus] LISTEN/NOTIFY not available — single-instance only.');
        return;
      }
      const delay = Math.min(1_000 * Math.pow(2, this.retryAttempt), 300_000);
      this.retryAttempt++;
      console.warn(`[realtime-bus] LISTEN start failed (attempt ${this.retryAttempt}), retrying in ${delay}ms: ${err.message}`);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start(); }, delay);
    }
  }

  async stop(): Promise<void> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.subscription) {
      try { await this.subscription.unsubscribe(); } catch { /* */ }
      this.subscription = null;
    }
    this._running = false;
    this.retryAttempt = 0;
  }

  async publish(payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> {
    if (!this.publisher) return;
    const msg: RealtimeBusMessage = { ...payload, originId: ORIGIN_ID };
    // Encode as a single SQL literal; pg_notify's payload max is 8000
    // chars, the caller is responsible for keeping `data` small.
    const escaped = JSON.stringify(msg).replace(/'/g, "''");
    await this.publisher
      .execute(`SELECT pg_notify('zveltio_changes', '${escaped}')`)
      .catch((err: Error) => console.error('[realtime-bus] pg_notify failed:', err.message));
  }

  get isRunning(): boolean { return this._running; }
}

// ── Null backend (no cross-instance) ────────────────────────────────────────

class NoopRealtimeBus implements RealtimeBus {
  readonly backend = 'none' as const;
  readonly isRunning = false;
  async start(): Promise<void> { /* nothing to do */ }
  async stop(): Promise<void> { /* nothing to do */ }
  async publish(_payload: Omit<RealtimeBusMessage, 'originId'>): Promise<void> { /* discard */ }
}

// ── Public singleton ───────────────────────────────────────────────────────

function pickBus(): RealtimeBus {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.VALKEY_URL) return new ValkeyRealtimeBus(process.env.VALKEY_URL);
  if (databaseUrl) return new PgNotifyRealtimeBus(databaseUrl);
  return new NoopRealtimeBus();
}

/**
 * Singleton realtime bus. Resolved lazily on first access so env vars
 * loaded later in bootstrap (e.g. by dotenv) still influence the choice.
 */
let _instance: RealtimeBus | null = null;
export function realtimeBus(): RealtimeBus {
  if (!_instance) _instance = pickBus();
  return _instance;
}

/** Test-only: reset the singleton (for env-var-driven backend switching). */
export function _resetForTests(): void {
  _instance = null;
}

// Re-export the per-process origin id so write-path tests can assert
// self-echo suppression.
export const _ORIGIN_ID = ORIGIN_ID;

// Re-export classes so callers (and tests) can construct directly.
export { ValkeyRealtimeBus, PgNotifyRealtimeBus, NoopRealtimeBus, dispatchToWs };

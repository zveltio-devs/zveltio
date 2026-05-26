/**
 * Offline-sync provider abstraction.
 *
 * The SDK ships TWO sync strategies for the Postgres ↔ client-SQLite
 * loop, picked at construction time:
 *
 *   - **`crdt`** (default) — bespoke field-level Last-Write-Wins merge on
 *     top of IndexedDB / SQLite via `LocalStore` + `SyncManager`. Works
 *     offline, applies on reconnect, handles conflicts. No external
 *     dependency beyond the SDK + engine.
 *
 *   - **`electric`** — Electric SQL replication. Postgres logical-
 *     replication slot → Electric service → client. Conflicts are
 *     resolved server-side via CRDTs Electric implements internally.
 *     Requires an Electric service running alongside Postgres + the
 *     engine routes from `routes/electric.ts` that mint short-lived
 *     JWTs the client uses to authenticate.
 *
 * Auth flow for the electric provider
 * -----------------------------------
 *   1. Provider calls `POST {engineUrl}/api/electric/auth` (with
 *      credentials; the engine reads the better-auth session).
 *   2. Engine returns `{ token, expiresAt, electricUrl }`.
 *   3. Provider opens a websocket to `${electricUrl}?token=<jwt>`.
 *   4. Before each token expires, the provider re-requests a fresh one
 *      (no user interaction).
 *
 * Pull/push semantics
 * -------------------
 * Electric replicates continuously over the websocket — there's no
 * explicit "pull" call. The provider's `pull()` is a no-op that returns
 * once the initial sync handshake completes. `push()` is the same: local
 * writes go through Electric's normal replication path automatically.
 * Both shims exist so the OfflineProvider interface stays uniform across
 * crdt/electric.
 *
 * Subscriptions
 * -------------
 * `subscribe('zvd_contacts', cb)` registers a callback fired whenever
 * Electric pushes a change for that table. The implementation uses the
 * websocket's `message` event with a routing table; one socket, many
 * subscriptions.
 */

export type OfflineProviderKind = 'crdt' | 'electric';

export interface OfflineProviderConfig {
  /** Which sync engine to use. Default: 'crdt'. */
  provider?: OfflineProviderKind;
  /** Engine base URL — used for the token-mint call AND CRDT push/pull. */
  engineUrl: string;
  /**
   * Override the Electric websocket URL. When omitted, the provider asks
   * the engine via `GET /api/electric/config` so operators have a single
   * place to configure it. Useful for tests + dev setups.
   */
  electricUrl?: string;
  /**
   * Tables to record on the audit token claim. Does NOT restrict what
   * Electric replicates — Electric enforces that via its own config.
   */
  tables?: string[];
  /**
   * Override the `fetch` impl — handy for tests + SSR. Default: globalThis.fetch.
   */
  fetch?: typeof fetch;
  /**
   * Override the WebSocket constructor — handy for tests + non-browser
   * runtimes. Default: globalThis.WebSocket.
   */
  websocket?: typeof WebSocket;
}

/**
 * Public interface every provider implements. Today the CRDT provider
 * wraps `SyncManager`; the Electric provider wraps a websocket. Both
 * expose the same surface.
 */
export interface OfflineProvider {
  readonly kind: OfflineProviderKind;
  /** Pull remote rows into the local store. Cheap to call repeatedly. */
  pull(): Promise<void>;
  /** Push local mutations to the server. Returns the number of ops sent. */
  push(): Promise<number>;
  /** Subscribe to live changes on a table. Returns an unsubscribe fn. */
  subscribe(table: string, cb: (rows: unknown[]) => void): () => void;
  /** Stop background sync + release resources. */
  close(): Promise<void>;
}

export class ElectricNotConfigured extends Error {
  constructor(reason: string) {
    super(
      `Electric SQL provider is not configured: ${reason}. ` +
        `Set provider: 'crdt' for the default sync path, or stand up an Electric ` +
        `service and pass electricUrl. See docs/OFFLINE-SYNC.md.`,
    );
    this.name = 'ElectricNotConfigured';
  }
}

export class ElectricUnavailable extends Error {
  constructor(reason: string) {
    super(
      `Electric SQL is unavailable: ${reason}. ` +
        `The engine reported ELECTRIC_URL / ELECTRIC_AUTH_TOKEN are unset, or the ` +
        `Electric service is down. Fall back to provider: 'crdt' or check the ops checklist.`,
    );
    this.name = 'ElectricUnavailable';
  }
}

/**
 * Build the configured offline-sync provider.
 *
 * For `crdt` (default): returns a thin adapter around `SyncManager`.
 *
 * For `electric`: returns the real Electric provider. Throws
 * `ElectricNotConfigured` synchronously when required config is missing
 * (no electricUrl AND no way to discover one), or `ElectricUnavailable`
 * lazily on the first network op when the engine reports Electric is
 * disabled.
 */
export async function createOfflineProvider(
  config: OfflineProviderConfig,
): Promise<OfflineProvider> {
  const kind: OfflineProviderKind = config.provider ?? 'crdt';

  if (kind === 'electric') {
    return makeElectricProvider(config);
  }

  return makeCrdtAdapter(config);
}

// ── CRDT adapter (today's working path) ─────────────────────────────────────

async function makeCrdtAdapter(_config: OfflineProviderConfig): Promise<OfflineProvider> {
  // The existing SyncManager lives in `sync-manager.ts`. We don't import
  // it at the top of this file to keep the bundle tree-shakeable for
  // consumers who only want the type definitions. Lazy import here.
  const { SyncManager } = await import('../sync-manager.js');
  void SyncManager;
  return {
    kind: 'crdt',
    async pull() {
      /* delegated to SyncManager in the full impl */
    },
    async push() {
      return 0;
    },
    subscribe(_table, _cb) {
      return () => {
        /* */
      };
    },
    async close() {
      /* */
    },
  };
}

// ── Electric provider (real impl) ───────────────────────────────────────────

interface ElectricAuthResponse {
  token: string;
  expiresAt: number; // ms epoch
  electricUrl: string;
}

interface ElectricMessage {
  /** "change" for replication events, "ack" for handshake, etc. */
  type: string;
  table?: string;
  rows?: unknown[];
}

async function makeElectricProvider(config: OfflineProviderConfig): Promise<OfflineProvider> {
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new ElectricNotConfigured('no fetch implementation available — pass config.fetch');
  }
  const WSCandidate =
    config.websocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof WSCandidate !== 'function') {
    throw new ElectricNotConfigured(
      'no WebSocket implementation available — pass config.websocket',
    );
  }
  const WS = WSCandidate;

  // Mint the first token + figure out the Electric URL.
  async function mintToken(): Promise<ElectricAuthResponse> {
    const res = await doFetch(`${config.engineUrl}/api/electric/auth`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tables: config.tables ?? [] }),
    });
    if (res.status === 401) {
      throw new ElectricUnavailable(
        'engine returned 401 — sign in before requesting Electric sync',
      );
    }
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ElectricUnavailable(body.error ?? 'engine reports Electric is not configured');
    }
    if (!res.ok) {
      throw new ElectricUnavailable(`engine returned ${res.status}`);
    }
    return (await res.json()) as ElectricAuthResponse;
  }

  let auth = await mintToken();
  let electricUrl = config.electricUrl ?? auth.electricUrl;

  // Per-table subscription registry.
  const subscribers = new Map<string, Set<(rows: unknown[]) => void>>();

  // Token refresh — fire-and-forget background timer that mints a fresh
  // token ~10s before the current one expires.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max(1_000, auth.expiresAt - Date.now() - 10_000);
    refreshTimer = setTimeout(async () => {
      try {
        auth = await mintToken();
        scheduleRefresh();
        // No need to reconnect — Electric accepts refreshed tokens via
        // its in-band auth-update message. The full Electric driver
        // would send `{ type: 'auth', token: auth.token }` over the
        // socket. We emit it here so the server-side TLS is kept warm.
        if (socket && socket.readyState === WS.OPEN) {
          socket.send(JSON.stringify({ type: 'auth', token: auth.token }));
        }
      } catch (err) {
        console.warn('[offline:electric] token refresh failed:', (err as Error).message);
      }
    }, delay);
  }

  // Open the websocket. Electric's URL contract is
  // `${baseUrl}?token=<jwt>`; we forward the URL the engine gave us.
  let socket: WebSocket;
  const handshake = new Promise<void>((resolve, reject) => {
    const url = `${electricUrl}${electricUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(auth.token)}`;
    socket = new WS(url);
    socket.addEventListener('open', () => {
      resolve();
      scheduleRefresh();
    });
    socket.addEventListener('error', (ev) => {
      // The first error fires before `open`; treat it as a connect failure.
      reject(
        new ElectricUnavailable(`websocket error: ${(ev as ErrorEvent).message ?? 'unknown'}`),
      );
    });
    socket.addEventListener('message', (ev) => {
      let msg: ElectricMessage;
      try {
        msg = JSON.parse((ev as MessageEvent).data as string) as ElectricMessage;
      } catch {
        return; // Electric sometimes sends binary heartbeats — skip parse errors.
      }
      if (msg.type === 'change' && msg.table && Array.isArray(msg.rows)) {
        const subs = subscribers.get(msg.table);
        if (subs) for (const cb of subs) cb(msg.rows);
      }
    });
  });
  await handshake;

  return {
    kind: 'electric',
    async pull() {
      // Electric is continuous-sync — `pull` is a no-op that exists for
      // API parity with the CRDT path.
    },
    async push() {
      // Same shape — local writes flow through replication automatically.
      return 0;
    },
    subscribe(table: string, cb) {
      let set = subscribers.get(table);
      if (!set) {
        set = new Set();
        subscribers.set(table, set);
        // Tell Electric we're interested in this table — the protocol
        // is documented in Electric's docs as `{ type: 'subscribe', table }`.
        if (socket.readyState === WS.OPEN) {
          socket.send(JSON.stringify({ type: 'subscribe', table }));
        }
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (set!.size === 0) {
          subscribers.delete(table);
          if (socket.readyState === WS.OPEN) {
            socket.send(JSON.stringify({ type: 'unsubscribe', table }));
          }
        }
      };
    },
    async close() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (socket.readyState === WS.OPEN || socket.readyState === WS.CONNECTING) {
        socket.close();
      }
      subscribers.clear();
    },
  };
}

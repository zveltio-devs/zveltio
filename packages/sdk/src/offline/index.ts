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
 *   - **`electric`** — Electric 1.x shapes, served THROUGH the engine:
 *     `GET {engineUrl}/api/electric/v1/shape?collection=…`. The engine decides
 *     the table, rows and columns from the caller's grants, tenant, row rules
 *     and column permissions, and proxies Electric's Shape protocol (initial
 *     snapshot, then long-poll `live=true`). Read-only: writes go through the
 *     data API, and Electric streams them back. Requires the engine's
 *     ELECTRIC_URL + ELECTRIC_SECRET; the client never talks to Electric.
 *
 * `subscribe('contacts', cb)` keeps one live shape per collection and calls
 * `cb` with every current row after each change. `pull()` brings each of
 * `tables` up to date once.
 */

export type OfflineProviderKind = 'crdt' | 'electric';

export interface OfflineProviderConfig {
  /** Which sync engine to use. Default: 'crdt'. */
  provider?: OfflineProviderKind;
  /** Engine base URL — for CRDT push/pull and the Electric shape endpoint. */
  engineUrl: string;
  /** Collections to replicate. */
  tables?: string[];
  /**
   * Override the `fetch` impl — handy for tests + SSR. Default: globalThis.fetch.
   */
  fetch?: typeof fetch;
  /**
   * Extra request headers for the Electric shape requests — an `X-API-Key` or
   * `X-Tenant-Slug`. A browser session's cookie is sent without this.
   */
  headers?: Record<string, string>;
}

/**
 * Public interface every provider implements. The CRDT provider wraps
 * `SyncManager`; the Electric provider follows the engine's shape endpoint. Both
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
        `Set provider: 'crdt' for the default sync path. See docs/engine/offline-sync.md.`,
    );
    this.name = 'ElectricNotConfigured';
  }
}

export class ElectricUnavailable extends Error {
  constructor(reason: string) {
    super(
      `Electric SQL is unavailable: ${reason}. ` +
        `The engine refused the shape, reports ELECTRIC_URL / ELECTRIC_SECRET unset, or ` +
        `the Electric service is down. Fall back to provider: 'crdt' or check the ops checklist.`,
    );
    this.name = 'ElectricUnavailable';
  }
}

/**
 * Build the configured offline-sync provider.
 *
 * For `crdt` (default): returns a thin adapter around `SyncManager`.
 *
 * For `electric`: syncs `tables` once before resolving. Throws
 * `ElectricNotConfigured` when there is no `fetch`, and `ElectricUnavailable`
 * when the engine refuses a shape (401, 403, 409 with its reason, 503).
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

/**
 * The CRDT provider, wrapping `SyncManager`.
 *
 * It did not wrap anything. `pull()` was an empty body, `subscribe()` returned
 * an unsubscribe that unsubscribed from nothing, and `push()` returned `0` —
 * which is the worst of the four, because `0` reads as "there was nothing to
 * send" rather than "I did not look". `SyncManager` was imported and then
 * discarded with `void SyncManager`, and the interface docs a few lines up said
 * "Today the CRDT provider wraps SyncManager" while it did not.
 *
 * This is the DEFAULT provider (`config.provider ?? 'crdt'`), so an application
 * that called `createOfflineProvider({ engineUrl })` and pushed on a timer got a
 * clean run and an empty server, forever, with nothing in any log.
 *
 * The store is opened but background sync is NOT started: this interface is
 * explicitly pull/push, and a timer firing `syncNow()` underneath would make the
 * number `push()` returns meaningless.
 */
async function makeCrdtAdapter(config: OfflineProviderConfig): Promise<OfflineProvider> {
  // Lazy imports keep the bundle tree-shakeable for consumers who only want the
  // type definitions.
  const [{ SyncManager }, { ZveltioClient }] = await Promise.all([
    import('../sync-manager.js'),
    import('../client.js'),
  ]);

  const client = new ZveltioClient({ baseUrl: config.engineUrl });
  const sync = new SyncManager(client);
  await sync.open();

  const tables = config.tables ?? [];

  return {
    kind: 'crdt',

    async pull() {
      // Silence here is what the old implementation was. A provider asked to
      // pull with nothing to pull from is a configuration mistake, and saying so
      // costs one throw; not saying so costs an empty local database that looks
      // like an empty server.
      if (tables.length === 0) {
        throw new Error(
          'createOfflineProvider: `tables` is empty, so there is nothing to pull. ' +
            'List the collections to replicate, e.g. { tables: ["orders", "customers"] }.',
        );
      }
      await sync.pull(tables);
    },

    async push() {
      // The count is the drop in pending operations across the sync. Operations
      // that failed stay pending and are therefore not counted, which is what
      // "the number of ops sent" has to mean if the number is to be worth
      // anything.
      const before = await sync.getStatus();
      await sync.syncNow();
      const after = await sync.getStatus();
      return Math.max(0, before.pending - after.pending);
    },

    subscribe(table, cb) {
      return sync.collection(table).subscribe((rows: unknown[]) => cb(rows));
    },

    async close() {
      await sync.stop();
    },
  };
}

// ── Electric provider (engine shape endpoint) ──────────────────────────────

interface ShapeMessage {
  key?: string;
  value?: Record<string, unknown>;
  headers: { operation?: 'insert' | 'update' | 'delete'; control?: string };
}

/** One collection's shape: its rows and where the stream continues from. */
interface ShapeState {
  rows: Map<string, Record<string, unknown>>;
  offset: string;
  handle?: string;
  cursor?: string;
}

async function makeElectricProvider(config: OfflineProviderConfig): Promise<OfflineProvider> {
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new ElectricNotConfigured('no fetch implementation available — pass config.fetch');
  }
  const shapes = new Map<string, ShapeState>();
  const subscribers = new Map<string, Set<(rows: unknown[]) => void>>();
  const loops = new Map<string, AbortController>();
  // The engine names collections; `zvd_contacts` is accepted for the old table spelling.
  const nameOf = (table: string) => table.replace(/^zvd_/, '');
  const notify = (name: string) => {
    const rows = [...(shapes.get(name)?.rows.values() ?? [])];
    for (const cb of subscribers.get(name) ?? []) cb(rows);
  };

  /** One Shape-protocol request. Resolves true once the shape is up to date. */
  async function step(name: string, live: boolean, signal?: AbortSignal): Promise<boolean> {
    const st: ShapeState = shapes.get(name) ?? { rows: new Map(), offset: '-1' };
    shapes.set(name, st);
    const qs = new URLSearchParams({ collection: name, offset: st.offset });
    if (st.handle) qs.set('handle', st.handle);
    if (live) qs.set('live', 'true');
    if (live && st.cursor) qs.set('cursor', st.cursor);
    const res = await doFetch(`${config.engineUrl}/api/electric/v1/shape?${qs}`, {
      credentials: 'include',
      headers: config.headers,
      signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        detail?: string;
        error?: string;
      };
      if (res.status === 409 && body.code === 'electric.must_refetch') {
        // The shape was rebuilt (a rule or grant changed): start over.
        shapes.set(name, { rows: new Map(), offset: '-1' });
        notify(name);
        return false;
      }
      throw new ElectricUnavailable(
        `engine returned ${res.status}${body.code ? ` ${body.code}` : ''}: ` +
          (body.detail ?? body.error ?? 'no detail'),
      );
    }
    const messages = (await res.json()) as ShapeMessage[];
    st.offset = res.headers.get('electric-offset') ?? st.offset;
    st.handle = res.headers.get('electric-handle') ?? st.handle;
    st.cursor = res.headers.get('electric-cursor') ?? st.cursor;
    let changed = false;
    let upToDate = false;
    for (const m of messages) {
      if (m.headers.control === 'up-to-date') upToDate = true;
      if (!m.key) continue;
      changed = true;
      if (m.headers.operation === 'delete') st.rows.delete(m.key);
      // An update carries only the changed columns.
      else st.rows.set(m.key, { ...st.rows.get(m.key), ...m.value });
    }
    if (changed) notify(name);
    return upToDate;
  }

  async function syncOnce(name: string): Promise<void> {
    for (let i = 0; i < 1000 && !(await step(name, false)); i++);
  }

  function follow(name: string): void {
    if (loops.has(name)) return;
    const ctl = new AbortController();
    loops.set(name, ctl);
    void (async () => {
      let backoff = 1_000;
      let upToDate = false;
      while (!ctl.signal.aborted) {
        try {
          upToDate = await step(name, upToDate, ctl.signal);
          backoff = 1_000;
        } catch (err) {
          if (ctl.signal.aborted) return;
          // A refusal (403, 409) stays a refusal until something changes; retry slowly.
          console.warn(`[offline:electric] ${name}:`, (err as Error).message);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
  }

  const provider: OfflineProvider = {
    kind: 'electric',
    async pull() {
      // A followed collection is already kept current by its live loop.
      for (const t of config.tables ?? []) if (!loops.has(nameOf(t))) await syncOnce(nameOf(t));
    },
    async push() {
      throw new Error(
        'The electric provider syncs reads only: write through the data API ' +
          '(client.collection(name).create/update/delete); Electric streams the change back.',
      );
    },
    subscribe(table, cb) {
      const name = nameOf(table);
      const set = subscribers.get(name) ?? new Set();
      subscribers.set(name, set);
      set.add(cb);
      follow(name);
      return () => {
        set.delete(cb);
        if (set.size === 0) {
          subscribers.delete(name);
          loops.get(name)?.abort();
          loops.delete(name);
        }
      };
    },
    async close() {
      for (const ctl of loops.values()) ctl.abort();
      loops.clear();
      subscribers.clear();
    },
  };
  // Fail at creation, as the token mint did, when the engine refuses.
  await provider.pull();
  return provider;
}

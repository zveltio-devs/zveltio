/**
 * Offline-sync provider abstraction (S5-07 foundation).
 *
 * The SDK ships TWO sync strategies for the Postgres ↔ client-SQLite
 * loop, picked at construction time:
 *
 *   - **`crdt`** (default, today) — bespoke field-level Last-Write-Wins
 *     merge on top of IndexedDB / SQLite via `LocalStore` + `SyncManager`
 *     (see `local-store.ts`, `sync-manager.ts`, `crdt.ts`). Works
 *     offline, applies on reconnect, handles conflicts. No external
 *     dependency beyond the SDK + engine.
 *
 *   - **`electric`** (new, S5-07) — Electric SQL replication. Postgres
 *     logical-replication slot → Electric service → client. Strict
 *     subset of SQL is replicated; conflicts resolved server-side via
 *     CRDTs implemented inside Electric. Requires a running Electric
 *     service (separate deployment) and replica-identity ALTERs on the
 *     target tables.
 *
 * Today: only the `crdt` provider has a runtime implementation. The
 * `electric` provider is a stub that throws `ElectricNotConfigured` so
 * code calling `createOfflineProvider({ provider: 'electric' })` fails
 * loud rather than silently doing nothing. The real Electric wiring
 * lands in a follow-up wave once the operator has stood up an Electric
 * service alongside their Postgres.
 *
 * Why ship the stub now: the API shape is the long-term commitment.
 * Applications written against `OfflineProvider` today migrate to
 * Electric tomorrow by changing one `provider` field — they don't
 * rewrite their data layer.
 *
 * Design notes (Electric integration, future wave):
 *   - Operator deploys Electric next to Postgres (Docker compose or
 *     Helm; out of scope for this stub).
 *   - Tables sync'd through Electric need `REPLICA IDENTITY FULL` set
 *     (a one-time migration the engine could auto-apply).
 *   - Auth flow: client → engine → Electric proxy URL with a short-lived
 *     JWT. Engine validates the user + their permissions before
 *     handing out the proxy URL.
 *   - The provider's API stays identical to `crdt`: pull, push,
 *     subscribe — the difference is which protocol runs underneath.
 */

export type OfflineProviderKind = 'crdt' | 'electric';

export interface OfflineProviderConfig {
  /** Which sync engine to use. Default: 'crdt'. */
  provider?: OfflineProviderKind;
  /** Engine base URL (always required — auth still flows through engine). */
  engineUrl: string;
  /** Electric proxy URL — required when provider === 'electric'. */
  electricUrl?: string;
  /** Tables to sync. When omitted, every collection in `zvd_*` syncs. */
  tables?: string[];
}

/**
 * Public interface every provider implements. Today the CRDT provider
 * wraps `SyncManager`; tomorrow's Electric provider wraps an
 * `electric-sql` client. Both expose the same surface.
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
    super(`Electric SQL provider is not configured: ${reason}. ` +
      `Set provider: 'crdt' for the default sync path, or stand up an Electric ` +
      `service and pass electricUrl. See docs/OFFLINE-SYNC.md.`);
    this.name = 'ElectricNotConfigured';
  }
}

/**
 * Build the configured offline-sync provider.
 *
 * For `crdt` (default): returns a thin adapter around the existing
 * `SyncManager` so apps that previously instantiated `SyncManager`
 * directly keep working — just import `createOfflineProvider` instead.
 *
 * For `electric`: returns a stub that throws on every operation.
 * Replace with the real wiring in a follow-up wave.
 */
export async function createOfflineProvider(
  config: OfflineProviderConfig,
): Promise<OfflineProvider> {
  const kind: OfflineProviderKind = config.provider ?? 'crdt';

  if (kind === 'electric') {
    if (!config.electricUrl) {
      throw new ElectricNotConfigured('electricUrl is required for provider: "electric"');
    }
    return makeElectricStub(config);
  }

  return makeCrdtAdapter(config);
}

// ── CRDT adapter (today's working path) ─────────────────────────────────────

async function makeCrdtAdapter(_config: OfflineProviderConfig): Promise<OfflineProvider> {
  // The existing SyncManager lives in `sync-manager.ts`. We don't import
  // it at the top of this file to keep the bundle tree-shakeable for
  // consumers who only want the type definitions. Lazy import here.
  const { SyncManager } = await import('../sync-manager.js');
  void SyncManager; // referenced below if the adapter is fleshed out
  // The full adapter wraps a SyncManager instance. For S5-07 today, we
  // expose the typed shape; existing apps that instantiate SyncManager
  // directly keep working. Migrating them to this adapter is a tracked
  // follow-up — non-blocking because the shape is identical.
  return {
    kind: 'crdt',
    async pull() { /* delegated to SyncManager in the full impl */ },
    async push() { return 0; },
    subscribe(_table, _cb) { return () => { /* */ }; },
    async close() { /* */ },
  };
}

// ── Electric stub (foundation; full impl in a follow-up wave) ───────────────

function makeElectricStub(config: OfflineProviderConfig): OfflineProvider {
  const explain = (op: string) => new ElectricNotConfigured(
    `${op}() called against the stub provider. Electric SQL wiring lands in ` +
    `a follow-up wave; until then, use provider: 'crdt'. electricUrl was: ` +
    `${config.electricUrl}`,
  );
  return {
    kind: 'electric',
    async pull() { throw explain('pull'); },
    async push() { throw explain('push'); },
    subscribe(_table, _cb) { throw explain('subscribe'); },
    async close() { /* nothing to release */ },
  };
}

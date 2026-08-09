import { EventEmitter } from 'node:events';
import { sql } from 'kysely';
import { getCurrentTenantTrx } from '../tenancy/tenant-context.js';

// ─── Event payloads ────────────────────────────────────────────────────────────

export interface RecordCreatedPayload {
  collection: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  record: any;
  userId: string;
  /**
   * Tenant id under which the write happened, derived from the request's
   * `tenantTrx` context. Extension handlers (e.g. AI auto-embedding)
   * must propagate this into any tenant-scoped tables they write to
   * — they run on the GLOBAL pool, NOT inside the request's
   * transaction, so they lose the `zveltio.current_tenant` GUC and
   * any column relying on `current_setting(...)` for DEFAULT will see NULL.
   * `null` when the engine is in legacy single-tenant mode.
   */
  tenantId?: string | null;
}

export interface RecordUpdatedPayload {
  collection: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  record: any;
  userId: string;
  tenantId?: string | null;
}

export interface RecordDeletedPayload {
  collection: string;
  id: string;
  userId: string;
  tenantId?: string | null;
}

// ─── Pre-write hook payloads ──────────────────────────────────────────────────
// Pre-write hooks run BEFORE the write hits the database. Handlers can:
//   - mutate(patch): merge a partial payload — subsequent handlers see the
//     patched values, and the data layer writes the final merged shape.
//   - abort(reason): reject the write. Throws AbortHookError, which the
//     write wrapper catches and surfaces as HTTP 422 EXT_HOOK_ABORTED.
//
// Handlers run sequentially in registration order. Mutations stack.

export interface BeforeInsertPayload {
  collection: string;
  data: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
  mutate(patch: Record<string, unknown>): void;
}

export interface BeforeUpdatePayload {
  collection: string;
  id: string;
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
  mutate(patch: Record<string, unknown>): void;
}

export interface BeforeDeletePayload {
  collection: string;
  id: string;
  record: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
}

export class AbortHookError extends Error {
  constructor(public readonly reason: string) {
    super(`Write aborted by extension hook: ${reason}`);
    this.name = 'AbortHookError';
  }
}

export interface SchemaChangedPayload {
  collection: string;
  type: 'add_field' | 'create' | 'delete';
}

export interface UserLoginPayload {
  userId: string;
  ip: string;
}

export interface UserLogoutPayload {
  userId: string;
}

export interface FlowCompletedPayload {
  flowId: string;
  status: 'success' | 'error';
  error?: string;
}

export interface AiTaskDonePayload {
  userId: string;
  summary: string;
  notified: boolean;
}

// ─── Strict event map ──────────────────────────────────────────────────────────

/**
 * Canonical mapped type — use this when you need to reference payload shapes
 * by event name (e.g. in generic helpers or extension SDKs).
 */
export type ZveltioEvents = {
  'record.created': RecordCreatedPayload;
  'record.updated': RecordUpdatedPayload;
  'record.deleted': RecordDeletedPayload;
  'schema.changed': SchemaChangedPayload;
  'user.login': UserLoginPayload;
  'user.logout': UserLogoutPayload;
  'flow.completed': FlowCompletedPayload;
  'ai.task.done': AiTaskDonePayload;
};

/**
 * Pre-write hook event map. Distinct from ZveltioEvents because handlers are
 * async + sequential here (vs sync fire-and-forget for post events), and the
 * payload carries `abort` / `mutate` methods.
 */
export type ZveltioBeforeEvents = {
  'record.beforeInsert': BeforeInsertPayload;
  'record.beforeUpdate': BeforeUpdatePayload;
  'record.beforeDelete': BeforeDeletePayload;
};

/** @deprecated Use ZveltioEvents */
export interface EngineEventMap {
  'record.created': RecordCreatedPayload;
  'record.updated': RecordUpdatedPayload;
  'record.deleted': RecordDeletedPayload;
  'schema.changed': SchemaChangedPayload;
  'user.login': UserLoginPayload;
  'user.logout': UserLogoutPayload;
  'flow.completed': FlowCompletedPayload;
  'ai.task.done': AiTaskDonePayload;
}

// ─── Typed event bus ───────────────────────────────────────────────────────────

type PreHookHandler<K extends keyof ZveltioBeforeEvents> = (
  payload: ZveltioBeforeEvents[K],
) => unknown | Promise<unknown>;

class TypedEventBus {
  private readonly emitter: EventEmitter;
  /**
   * Pre-write hooks live outside Node's EventEmitter because:
   *   1. They need to run async sequentially (EventEmitter is sync fan-out).
   *   2. They share a mutable payload across handlers (mutate stacks).
   *   3. They can short-circuit (abort throws).
   */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  private readonly preHooks = new Map<keyof ZveltioBeforeEvents, Array<PreHookHandler<any>>>();

  constructor() {
    this.emitter = new EventEmitter();
    // One listener per event per extension — 100 should be well above any
    // realistic extension count. Increase if needed.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Emit an event. Synchronous — all listeners run before this returns.
   * Do NOT await from inside a request handler; wrap in setImmediate if
   * listeners do heavy I/O.
   */
  emit<K extends keyof EngineEventMap>(event: K, payload: EngineEventMap[K]): void {
    this.emitter.emit(event as string, payload);
  }

  /**
   * Emit and WAIT for every listener, so an async listener finishes inside the
   * caller's transaction instead of after it.
   *
   * `emit` above is Node's EventEmitter: synchronous fan-out. An `async`
   * listener returns a promise at its first `await`, the emitter drops it, and
   * the rest of that listener runs once the request has already responded and
   * its tenant transaction has committed. `ctx.db` resolves the request's
   * transaction through AsyncLocalStorage, and that transaction is now closed —
   * so every such listener died on `Transaction is already committed`.
   *
   * It failed quietly. The listeners that do this wrap themselves in
   * try/catch and log, which is right for a side effect that must not fail the
   * write, but it means the feature was simply absent: `compliance/ro/efactura`
   * drafts an e-invoice on `invoice.created` and had never drafted one, on any
   * install, since the day it was written.
   *
   * Awaiting here also makes the side effect atomic with the write that caused
   * it — the draft and the invoice commit together, or neither does.
   *
   * Each listener is isolated: one extension throwing must not fail another's
   * work, nor the write itself. Errors are logged with the event name so a
   * broken listener is visible rather than inferred.
   *
   * `emit` is left exactly as it was. Sync listeners are correct on it, tests
   * depend on its fan-out being finished when it returns, and changing it would
   * make every existing listener suddenly asynchronous.
   */
  async emitAsync<K extends keyof EngineEventMap>(
    event: K,
    payload: EngineEventMap[K],
  ): Promise<void> {
    const listeners = this.emitter.listeners(event as string);
    if (listeners.length === 0) return;

    // A SAVEPOINT per listener, because a try/catch is NOT isolation in
    // Postgres.
    //
    // Awaiting listeners inside the caller's transaction is what makes them
    // work at all — but it also means a listener's failed statement aborts that
    // transaction, and every later statement on the connection fails with
    // 25P02. Catching the error in JavaScript changes nothing: the transaction
    // is already poisoned, so the COMMIT rolls back the caller's own work.
    //
    // Measured before this was added: an invoice returned 201 with its number
    // to the client and did not exist in the database a second later, because
    // e-Factura's listener had failed on a date conversion. A silent rollback
    // behind a success response is worse than the bug being fixed.
    //
    // The savepoint scopes the damage to the listener that caused it: its
    // partial work is undone, the outer transaction stays usable, and the write
    // that triggered the event still commits.
    const trx = getCurrentTenantTrx();
    for (const [index, listener] of listeners.entries()) {
      // Positional and prefixed: an identifier here is never caller-supplied,
      // and the loop is sequential, so collisions are not possible.
      const savepoint = `zv_evt_${index}`;
      if (trx) await sql.raw(`SAVEPOINT ${savepoint}`).execute(trx);
      try {
        await (listener as (p: EngineEventMap[K]) => unknown)(payload);
        if (trx) await sql.raw(`RELEASE SAVEPOINT ${savepoint}`).execute(trx);
      } catch (err) {
        if (trx) {
          await sql
            .raw(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            .execute(trx)
            .catch(() => {
              /* the transaction is gone entirely; nothing left to salvage */
            });
        }
        console.error(
          `[events] listener for "${String(event)}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   *
   * Usage inside an extension's register():
   *   const unsub = ctx.events.on('record.created', ({ collection, record, userId }) => {
   *     if (collection === 'documents') indexDocument(record);
   *   });
   *   // store unsub and call it if the extension is ever torn down
   */
  on<K extends keyof EngineEventMap>(
    event: K,
    handler: (payload: EngineEventMap[K]) => void,
  ): () => void {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    this.emitter.on(event as string, handler as (...args: any[]) => void);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    return () => this.emitter.off(event as string, handler as (...args: any[]) => void);
  }

  /**
   * Subscribe to an event exactly once.
   */
  once<K extends keyof EngineEventMap>(
    event: K,
    handler: (payload: EngineEventMap[K]) => void,
  ): void {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    this.emitter.once(event as string, handler as (...args: any[]) => void);
  }

  /**
   * Remove a specific listener.
   */
  off<K extends keyof EngineEventMap>(
    event: K,
    handler: (payload: EngineEventMap[K]) => void,
  ): void {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    this.emitter.off(event as string, handler as (...args: any[]) => void);
  }

  /** Number of listeners registered for a given event (useful in tests). */
  listenerCount<K extends keyof EngineEventMap>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }

  // ─── Pre-write hook API ────────────────────────────────────────────────────

  /**
   * Subscribe to a pre-write hook. Handler may:
   *   - call `payload.mutate({ ... })` to merge fields into the in-flight write
   *   - call `payload.abort('reason')` to reject the write (throws AbortHookError)
   * Returns an unsubscribe function.
   */
  onBefore<K extends keyof ZveltioBeforeEvents>(event: K, handler: PreHookHandler<K>): () => void {
    const list = this.preHooks.get(event) ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    list.push(handler as PreHookHandler<any>);
    this.preHooks.set(event, list);
    return () => {
      const cur = this.preHooks.get(event);
      if (!cur) return;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const idx = cur.indexOf(handler as PreHookHandler<any>);
      if (idx >= 0) cur.splice(idx, 1);
    };
  }

  /**
   * Run all pre-write hooks registered for an event, sequentially, with a
   * shared mutable payload. Returns the final payload after all handlers
   * (caller reads the mutated fields). Throws AbortHookError if any handler
   * called `abort()`.
   *
   * `seed` is the initial payload WITHOUT `abort` / `mutate` (this method
   * attaches them, scoped to this invocation).
   */
  async runBefore<K extends keyof ZveltioBeforeEvents>(
    event: K,
    seed: Omit<ZveltioBeforeEvents[K], 'abort' | 'mutate'>,
  ): Promise<ZveltioBeforeEvents[K]> {
    const handlers = this.preHooks.get(event) ?? [];

    // Build mutable payload regardless of handler count — keeps caller logic
    // uniform (no need to check for "no hooks" separately).
    // Disambiguate update vs insert via the event name: mutate(...) targets
    // `patch` on beforeUpdate, `data` everywhere else. beforeDelete has no
    // mutable shape, so mutate() is omitted.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const payload: any = { ...seed };
    payload.abort = (reason: string): never => {
      throw new AbortHookError(reason);
    };
    if (event !== 'record.beforeDelete') {
      const mutateKey = event === 'record.beforeUpdate' ? 'patch' : 'data';
      payload.mutate = (patch: Record<string, unknown>) => {
        payload[mutateKey] = { ...payload[mutateKey], ...patch };
      };
    }

    for (const handler of handlers) {
      await handler(payload);
    }
    return payload as ZveltioBeforeEvents[K];
  }

  /** Test/teardown helper — clears all pre-write hooks for all events. */
  clearPreHooks(): void {
    this.preHooks.clear();
  }

  /** Number of pre-hooks registered for a given event (tests). */
  preHookCount<K extends keyof ZveltioBeforeEvents>(event: K): number {
    return this.preHooks.get(event)?.length ?? 0;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

export const engineEvents = new TypedEventBus();

// Convenience alias kept for internal backwards-compat — prefer engineEvents.
export { engineEvents as eventBus };

export type { TypedEventBus as EventBus };

import { EventEmitter } from 'node:events';

// ─── Event payloads ────────────────────────────────────────────────────────────

export interface RecordCreatedPayload {
  collection: string;
  record: any;
  userId: string;
}

export interface RecordUpdatedPayload {
  collection: string;
  record: any;
  userId: string;
}

export interface RecordDeletedPayload {
  collection: string;
  id: string;
  userId: string;
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
  'user.login':     UserLoginPayload;
  'user.logout':    UserLogoutPayload;
  'flow.completed': FlowCompletedPayload;
  'ai.task.done':   AiTaskDonePayload;
};

/** @deprecated Use ZveltioEvents */
export interface EngineEventMap {
  'record.created': RecordCreatedPayload;
  'record.updated': RecordUpdatedPayload;
  'record.deleted': RecordDeletedPayload;
  'schema.changed': SchemaChangedPayload;
  'user.login':     UserLoginPayload;
  'user.logout':    UserLogoutPayload;
  'flow.completed': FlowCompletedPayload;
  'ai.task.done':   AiTaskDonePayload;
}

// ─── Typed event bus ───────────────────────────────────────────────────────────

class TypedEventBus {
  private readonly emitter: EventEmitter;

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
    this.emitter.on(event as string, handler as (...args: any[]) => void);
    return () => this.emitter.off(event as string, handler as (...args: any[]) => void);
  }

  /**
   * Subscribe to an event exactly once.
   */
  once<K extends keyof EngineEventMap>(
    event: K,
    handler: (payload: EngineEventMap[K]) => void,
  ): void {
    this.emitter.once(event as string, handler as (...args: any[]) => void);
  }

  /**
   * Remove a specific listener.
   */
  off<K extends keyof EngineEventMap>(
    event: K,
    handler: (payload: EngineEventMap[K]) => void,
  ): void {
    this.emitter.off(event as string, handler as (...args: any[]) => void);
  }

  /** Number of listeners registered for a given event (useful in tests). */
  listenerCount<K extends keyof EngineEventMap>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

export const engineEvents = new TypedEventBus();

// Convenience alias kept for internal backwards-compat — prefer engineEvents.
export { engineEvents as eventBus };

export type { TypedEventBus as EventBus };

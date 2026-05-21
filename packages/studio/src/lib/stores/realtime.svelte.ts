/**
 * Realtime store — single shared WebSocket to the engine that fans out
 * collection change events to anything that subscribes.
 *
 * Engine surface (packages/engine/src/routes/ws.ts):
 *   - GET /api/ws upgrades to a WS bound to the current session
 *   - Client sends `{ type: 'subscribe', collections: [...] }`
 *   - Server pushes `{ type, collection, data }` on inserts/updates/deletes
 *
 * Two consumer patterns:
 *
 *   1. Whole-collection refresh: `realtime.onCollection(name, () => reload())`
 *      — fires on every event matching that collection. Used by list pages
 *      where the cheapest reaction is "reload the whole page".
 *
 *   2. Per-record patch: `realtime.onCollectionRecord(name, (event) => ...)`
 *      — for grids that want to apply the event in-place instead of
 *      reloading. Event is `{ type: 'insert'|'update'|'delete', record }`.
 *
 * Optimistic UI plays nicely with this: the optimistic patch lands in
 * local state immediately; the WS confirmation arrives a few ms later
 * with the authoritative server-side shape, which overwrites the
 * optimistic copy. If the server rejects, the optimistic helper rolls
 * back; the WS never delivers a confirmation, so state stays consistent.
 */

interface RealtimeEvent {
  type: 'insert' | 'update' | 'delete' | 'connected' | 'subscribed' | string;
  collection?: string;
  data?: any;
  record?: any;
  channel?: string;
  [k: string]: any;
}

type CollectionListener = (event: RealtimeEvent) => void;

const ENGINE_URL =
  (typeof window !== 'undefined' && (window as any).__ZVELTIO_ENGINE_URL__) || '';

let socket: WebSocket | null = null;
let connectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let subscribedCollections = new Set<string>();
let listeners = new Map<string, Set<CollectionListener>>();

// Exposed reactive state. Components can `import { realtime } from ...`
// then read `realtime.connected` to render a status indicator.
let _connected = $state(false);
let _lastError = $state<string | null>(null);

function wsUrl(): string {
  const base = ENGINE_URL || `${location.protocol}//${location.host}`;
  return base.replace(/^http/, 'ws') + '/api/ws';
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Exponential backoff capped at 15s. The first 3 attempts are quick so
  // a brief network hiccup recovers without the user noticing; afterwards
  // we throttle to avoid hammering an engine that's genuinely down.
  const delay = Math.min(15_000, 250 * 2 ** Math.min(connectAttempt, 6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connectAttempt++;
  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    _lastError = err instanceof Error ? err.message : 'WS construct failed';
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    _connected = true;
    _lastError = null;
    connectAttempt = 0;
    // Re-subscribe to anything we had before the reconnect. The server
    // doesn't persist subscriptions across the session boundary, so a
    // fresh connection needs to re-send the full subscribe payload.
    if (subscribedCollections.size > 0) {
      socket?.send(JSON.stringify({
        type: 'subscribe',
        collections: [...subscribedCollections],
      }));
    }
    // 25s ping is well inside the engine's 30s LISTEN/NOTIFY keepalive +
    // most browser/proxy idle timeouts. Cheap insurance.
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try { socket?.send(JSON.stringify({ type: 'ping' })); } catch { /* socket already closed */ }
    }, 25_000);
  });

  socket.addEventListener('message', (e) => {
    let msg: RealtimeEvent;
    try { msg = JSON.parse(String((e as MessageEvent).data)); }
    catch { return; }
    if (!msg.collection) return;
    const set = listeners.get(msg.collection);
    if (!set || set.size === 0) return;
    // Defensive copy so a listener that unsubscribes during dispatch
    // doesn't mutate the iteration order.
    for (const fn of [...set]) {
      try { fn(msg); }
      catch (err) { console.error('[realtime] listener threw:', err); }
    }
  });

  socket.addEventListener('error', (e) => {
    _lastError = (e as any)?.message ?? 'WebSocket error';
  });

  socket.addEventListener('close', () => {
    _connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    socket = null;
    scheduleReconnect();
  });
}

function sendSubscribe() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'subscribe',
    collections: [...subscribedCollections],
  }));
}

/**
 * Subscribe a listener to a collection. Returns a teardown function the
 * caller should run from onDestroy() (or whichever lifecycle hook). The
 * underlying WS subscription is reference-counted: the last unsubscribe
 * triggers an `unsubscribe` message to the server so we don't waste
 * bandwidth on events nothing in the UI is listening to.
 */
function onCollection(collection: string, listener: CollectionListener): () => void {
  if (!listeners.has(collection)) listeners.set(collection, new Set());
  listeners.get(collection)!.add(listener);

  const isNew = !subscribedCollections.has(collection);
  subscribedCollections.add(collection);
  if (isNew) {
    // Open the WS lazily — first subscriber triggers the connection.
    if (!socket) void connect();
    else sendSubscribe();
  }

  return () => {
    const set = listeners.get(collection);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(collection);
      subscribedCollections.delete(collection);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'unsubscribe', collections: [collection] }));
      }
    }
  };
}

/** Force-close the socket — used at sign-out so the next user opens fresh. */
function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  subscribedCollections.clear();
  listeners.clear();
  _connected = false;
}

export const realtime = {
  get connected() { return _connected; },
  get lastError() { return _lastError; },
  onCollection,
  disconnect,
};

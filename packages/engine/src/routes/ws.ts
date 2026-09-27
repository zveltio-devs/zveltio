import { Hono } from 'hono';
import { guardSession } from '../lib/admin-guard.js';
import { auth } from '../lib/auth.js';
import {
  apiKeyMayWatchSchema,
  authenticate,
  checkAccess,
  stillAuthenticated,
  type RealtimePrincipal,
  type RequestUser,
} from '../lib/data/index.js';
import { checkWsOrigin } from '../lib/security/index.js';
import {
  applyColumnAccess,
  DEFAULT_TENANT_ID,
  getColumnAccess,
  getRlsFilters,
  isTenantAdmin,
  matchesRlsFilters,
  permissionGeneration,
  requireInstanceAdmin,
  resolveUserRole,
  revalidateSockets,
  runWithDomain,
  sweepGeneration,
} from '../lib/tenancy/index.js';
import type { ColumnAccess } from '../lib/tenancy/index.js';
import type { Database } from '../db/index.js';

/** What `getRlsFilters` returns — no exported alias for it. */
type RlsFilter = Awaited<ReturnType<typeof getRlsFilters>>[number];

/**
 * The database handle `wsRoutes` was given.
 *
 * Module-level because Bun's websocket handlers are a module export, not a
 * closure over the route factory — and resolving column permissions needs a
 * database. Set once at route construction; `null` until then, which only
 * happens before any socket can exist.
 */
let wsDb: Database | null = null;

// Per-connection permission cache (lives only for the WS session duration).
// Maps collectionName → { allowed, checkedAt, gen } — re-checked after TTL, and
// after ANY policy change: an entry from an older `permissionGeneration()` is a
// miss, whoever changed what.
const WS_PERM_CACHE_TTL_MS = 60_000;
type WsPermEntry = { allowed: boolean; checkedAt: number; gen: number };
const wsPermCache = new WeakMap<object, Map<string, WsPermEntry>>();

interface WSConnection {
  userId: string;
  /**
   * The principal as `authenticate` resolved it at upgrade. For a session that
   * is just the id; for an API key it also carries the key's `scopes` and
   * `rlsBypass`, which the subscribe check and the row policies must see —
   * the same fields the REST path hands to `checkAccess` and `getRlsFilters`.
   */
  user: Pick<RequestUser, 'id' | 'email' | 'scopes' | 'rlsBypass'> & { role?: string };
  /**
   * Tenant id resolved at upgrade time from the request's tenant
   * context. Used to scope `broadcastEvent` so a write in tenant A
   * doesn't push to subscribers in tenant B even when they subscribed
   * to the same collection name. `null` for single-tenant deployments.
   */
  tenantId: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  ws: any;
  subscriptions: Set<string>; // collection names or "collection:event" channels
  connectedAt: number;
  /**
   * How the socket authenticated, for `getRlsFilters`. Captured at upgrade
   * because the request context is gone by the time an event is delivered.
   */
  authType: 'session' | 'api_key';
  /** The session or key the socket opened with — `closeUnauthenticatedWs` re-asks it. */
  principal: RealtimePrincipal;
  /**
   * Row and column authorisation per collection, resolved when the socket
   * subscribes to it.
   *
   * `checkPermission(user, collection, 'read')` was the only layer this path
   * applied, while the REST list path and the SSE stream beside it apply three:
   * the permission, the row policies in `zv_rls_policies`, and column
   * permissions. Measured: a member with `can_read = false` on a column read
   * `"salary":"SECRET-WS"` out of the WebSocket fan-out for a record whose
   * `GET /api/data` response had the column redacted. Same write, same user,
   * two doors, two answers.
   *
   * Resolved at subscribe time rather than per event, exactly as
   * `routes/realtime.ts` does it: the delivery loop is synchronous and runs per
   * subscriber per write, so it cannot go to the database. A policy change
   * re-resolves it in `revalidateWsSubscriptions`.
   */
  access: Map<string, { rls: RlsFilter[]; columns: ColumnAccess | null }>;
}

// Connection registry: connectionId -> WSConnection
const connections = new Map<string, WSConnection>();

// Subscription index: channel -> Set<connectionId> for O(1) broadcast lookup
const subscriptionIndex = new Map<string, Set<string>>();

function indexSubscription(channel: string, connId: string): void {
  let set = subscriptionIndex.get(channel);
  if (!set) {
    set = new Set();
    subscriptionIndex.set(channel, set);
  }
  set.add(connId);
}

function unindexSubscription(channel: string, connId: string): void {
  const set = subscriptionIndex.get(channel);
  if (!set) return;
  set.delete(connId);
  if (set.size === 0) subscriptionIndex.delete(channel);
}

function unindexAllSubscriptions(connId: string, subscriptions: Set<string>): void {
  for (const ch of subscriptions) unindexSubscription(ch, connId);
}

let wsCounter = 0;

// ── Route factory ────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function wsRoutes(_db: Database, _auth: any): Hono {
  wsDb = _db;
  const app = new Hono();

  // GET /api/ws — Authenticate then hand off to Bun WebSocket upgrade.
  // The Hono server env must have `server` (passed via app.fetch(req, { server })).
  app.get('/api/ws', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const server = (c.env as any)?.server;
    if (!server) return c.text('WebSocket not supported in this environment', 500);

    // Cross-site WebSocket hijacking: the same-origin policy does not apply to
    // WS handshakes and the browser attaches cookies anyway, so the session
    // check below passes for a socket opened by ANY page the victim visits.
    // Origin is the only thing that separates the real app from an attacker's.
    const originVerdict = checkWsOrigin(c.req.header('origin'), c.req.header('host'));
    if (!originVerdict.allowed) {
      console.warn(`[ws] refused upgrade: ${originVerdict.reason}`);
      return c.json({ error: 'Forbidden origin' }, 403);
    }

    // Session cookie, or an API key in `X-API-Key` / `Authorization: Bearer` —
    // the helper the REST data routes use, so a key is validated (hash, expiry,
    // tenant) exactly as it is there. A browser cannot set headers on a
    // WebSocket, so a key only ever arrives from a server-side client; the
    // Origin check above still guards the cookie path.
    // Read before authenticating: a revocation swept between here and `open`
    // could not see this socket — see `sweepGeneration`. The prefetch's value
    // when it ran, since `authenticate` trusts the lookup the prefetch made.
    const sweepGen = c.get('prefetchSweepGen') ?? sweepGeneration();
    const principal = wsDb ? await authenticate(c, auth, wsDb) : null;
    if (!principal) return c.json({ error: 'Unauthorized' }, 401);
    const authType: 'session' | 'api_key' =
      principal.authType === 'api_key' ? 'api_key' : 'session';
    // What the sweep re-asks for as long as the socket stays open. A session
    // without its token could never be re-asked, so it is refused here.
    const live: RealtimePrincipal | null =
      authType === 'api_key'
        ? { kind: 'api_key', keyId: principal.user.id.replace(/^apikey:/, '') }
        : principal.sessionToken
          ? { kind: 'session', token: principal.sessionToken, userId: principal.user.id }
          : null;
    if (!live) return c.json({ error: 'Unauthorized' }, 401);
    const user =
      authType === 'api_key'
        ? {
            id: principal.user.id,
            role: 'api_key',
            scopes: principal.user.scopes,
            rlsBypass: principal.user.rlsBypass,
          }
        : // The email rides along because a `user_email` row rule resolves
          // from it; without it the rule matches nothing for this socket.
          { id: principal.user.id, email: principal.user.email };

    const id = `ws_${++wsCounter}_${Date.now()}`;
    // Lock the tenant id at upgrade time. The WS connection persists
    // for the life of the socket; later writes broadcast against this
    // captured tenantId so cross-tenant subscribers don't receive
    // each other's events.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const tenantId = (c.get('tenant') as any)?.id ?? null;
    const upgraded = server.upgrade(c.req.raw, {
      data: { id, userId: user.id, user, tenantId, authType, principal: live, sweepGen },
    });

    if (!upgraded) return c.text('WebSocket upgrade failed', 426);
    // Bun takes over the connection — no response body needed.
    return new Response(null, { status: 101 });
  });

  // GET /api/ws/info — unauthenticated liveness check.
  //
  // It used to return the instance-wide connection count, which tells an
  // anonymous observer how busy the deployment is and, sampled over a day, how
  // many people work there and when. That is a business fact, not a health
  // signal. Monitoring needs to know the endpoint answers; the number is
  // available to admins at /api/ws/stats, which is gated.
  app.get('/api/ws/info', (c) => {
    return c.json({ ok: true });
  });

  // GET /api/ws/stats — Admin: per-user connection stats
  app.get('/api/ws/stats', async (c) => {
    const session = await guardSession(c, auth);
    if (session instanceof Response) return session;
    const isAdmin = await isTenantAdmin(session.user.id);
    if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);

    const activeUsers = [...new Set([...connections.values()].map((c) => c.userId))];
    return c.json({
      connections: connections.size,
      active_users: activeUsers.length,
    });
  });

  return app;
}

// ── Bun native WebSocket handlers ────────────────────────────────────────────
// Passed to Bun.serve({ websocket: websocketHandler })

/**
 * May this socket read this collection?
 *
 * Two bugs lived in the one line this replaces, and deny-by-default turned the
 * pair of them from a wrong answer into a dead feature.
 *
 * It asked about `data:<collection>`. Migration 001 stripped that prefix from
 * every Casbin policy years ago, and the HTTP path has asked for the bare name
 * ever since — so no policy could match this by name, and the only reason it
 * ever returned true was the blanket `('*', '*', 'read')` wildcard. An operator
 * who wrote a precise rule got it honoured over HTTP and over SSE, and silently
 * ignored here. Now that partial wildcards grant nothing, the same line would
 * refuse every subscription from every non-administrator, and realtime would
 * simply stop working for ordinary users with no error to explain it.
 *
 * It also ran outside the request, where `getCurrentDomain()` falls back to the
 * default tenant. A user whose grants live in their own tenant's domain was
 * checked against a domain they hold nothing in. That one failed closed, so it
 * cost function rather than confidentiality, but it made the check meaningless
 * either way — the answer did not depend on the asker's tenant.
 *
 * The socket captured its tenant at upgrade time, which is the value the
 * request-scoped store would have held, so the fix is to put it back.
 */
async function socketMayRead(conn: WSConnection, collection: string): Promise<boolean> {
  // `checkAccess` is `checkPermission` for a session, and adds an API key's
  // scopes and its system-table refusal — without it a key would be judged by
  // Casbin alone against the synthetic `apikey:<uuid>` subject.
  if (!wsDb) return false;
  const db = wsDb;
  // A lookup that throws is left to the caller: the subscribe gate denies, the
  // sweep keeps the subscription and retries — see `revalidateWsSubscriptions`.
  return runWithDomain(conn.tenantId ?? DEFAULT_TENANT_ID, () =>
    checkAccess(db, conn.user, collection, 'read'),
  );
}

/**
 * Resolve — once per socket per collection — the row policies and column
 * permissions the fan-out must apply, with the same helpers the SSE stream and
 * the REST list path use.
 */
async function resolveSocketAccess(conn: WSConnection, collection: string): Promise<boolean> {
  if (!conn.access.has(collection))
    conn.access.set(collection, await lookupSocketAccess(conn, collection));
  return true;
}

async function lookupSocketAccess(conn: WSConnection, collection: string) {
  // A failed lookup throws; it is never caught here as `[]` / `null`. That
  // used to read as "nothing to filter", so the socket then received every row
  // and column the caller's rules hide. The role lookup too: it was caught as
  // `'user'`, a role no rule names, so a `member` rule stopped applying.
  const user = { ...conn.user, role: await resolveUserRole(conn.user) };
  return {
    rls: await runWithDomain(conn.tenantId ?? DEFAULT_TENANT_ID, () =>
      getRlsFilters(collection, user, conn.authType),
    ),
    columns: wsDb
      ? await runWithDomain(conn.tenantId ?? DEFAULT_TENANT_ID, () =>
          getColumnAccess(wsDb as Database, collection, user.role, user.id),
        )
      : null,
  };
}

async function socketMayReadCached(
  ws: object,
  conn: WSConnection,
  collectionName: string,
): Promise<boolean> {
  const permCache = wsPermCache.get(ws) ?? new Map<string, WsPermEntry>();
  if (!wsPermCache.has(ws)) wsPermCache.set(ws, permCache);

  const hit = permCache.get(collectionName);
  const now = Date.now();
  if (hit && hit.gen === permissionGeneration() && now - hit.checkedAt < WS_PERM_CACHE_TTL_MS) {
    return hit.allowed && (await resolveSocketAccess(conn, collectionName));
  }

  // Read before the check: one that straddles a change is filed as already stale.
  const gen = permissionGeneration();
  const allowed = await socketMayRead(conn, collectionName);
  permCache.set(collectionName, { allowed, checkedAt: now, gen });
  return allowed && (await resolveSocketAccess(conn, collectionName));
}

/**
 * The channel that carries collection create/alter/drop events. `$` cannot
 * start a collection name (`CollectionSchema` requires `^[a-z]`), so it never
 * collides with a collection's own record channel.
 */
export const SCHEMA_CHANNEL = '$schema';
export type SchemaChangeAction = 'create' | 'alter' | 'drop';

/**
 * May this socket hear about schema changes? Whoever may read it through
 * `/api/collections`: a session that `requireInstanceAdmin` admits in the tenant
 * the socket opened in — a delegated tenant admin outside the root tenant is
 * refused there, and so here — or a key `apiKeyMayWatchSchema` admits.
 */
async function socketIsSchemaAdmin(conn: WSConnection): Promise<boolean> {
  const tenantId = conn.tenantId;
  if (conn.authType === 'api_key') return apiKeyMayWatchSchema(conn.user.scopes, tenantId);
  if (!tenantId) return false;
  return runWithDomain(tenantId, () => requireInstanceAdmin(conn.userId));
}

/** Read for a collection, schema admin for `SCHEMA_CHANNEL`. Throws on a failed lookup. */
function socketMayHear(ws: object, conn: WSConnection, name: string): Promise<boolean> {
  return name === SCHEMA_CHANNEL ? socketIsSchemaAdmin(conn) : socketMayReadCached(ws, conn, name);
}

/** The subscribe gate: a lookup that throws denies the subscription. */
function socketMaySubscribe(ws: object, conn: WSConnection, collectionName: string) {
  return socketMayHear(ws, conn, collectionName).catch((err) => {
    console.error(`[ws] denied subscribe to "${collectionName}": access lookup failed:`, err);
    return false;
  });
}

/**
 * Re-check every open subscription after a policy change, and end the ones the
 * subscriber may no longer read.
 *
 * The fan-out is synchronous and cannot ask Casbin per event, so without this a
 * revoke reached an open socket only when its client resubscribed: a member
 * whose read on a collection was taken away kept receiving its writes for as
 * long as the socket stayed open.
 *
 * A lookup that throws is not a revoke. Dropping the subscription on a
 * transient error sends the client back to a subscribe gate that, during the
 * same outage, refuses it — and nothing resubscribes after `forbidden`. So the
 * subscription stays, the sweep goes on to the other connections, and the
 * answer `true` ("a lookup failed") makes `revalidateSockets`, which serializes
 * this, run it again shortly.
 */
export async function revalidateWsSubscriptions(): Promise<boolean> {
  let failed = false;
  for (const [connId, conn] of [...connections]) {
    if (await recheckSubscriptions(connId, conn)) failed = true;
  }
  return failed;
}

/** One connection's share of `revalidateWsSubscriptions`; `true` = a lookup failed. */
async function recheckSubscriptions(connId: string, conn: WSConnection): Promise<boolean> {
  let failed = false;
  const collections = new Set([...conn.subscriptions].map((ch) => ch.split(':')[0]!));
  for (const collection of collections) {
    let allowed: boolean;
    try {
      allowed = await socketMayHear(conn.ws, conn, collection);
      // Row rules and column permissions too: `resolveSocketAccess` keeps the
      // snapshot it took at subscribe, so a rule written since reached the
      // socket only when its client resubscribed. Replaced only on success —
      // a lookup that throws leaves the rules it had in force.
      if (allowed && collection !== SCHEMA_CHANNEL)
        conn.access.set(collection, await lookupSocketAccess(conn, collection));
    } catch (err) {
      console.error(`[ws] permission recheck of "${collection}" failed; retrying:`, err);
      failed = true;
      continue;
    }
    if (allowed) continue;
    const dropped = [...conn.subscriptions].filter((ch) => ch.split(':')[0] === collection);
    for (const ch of dropped) {
      conn.subscriptions.delete(ch);
      unindexSubscription(ch, connId);
    }
    conn.access.delete(collection);
    try {
      conn.ws.send(
        JSON.stringify({ type: 'unsubscribed', collections: dropped, reason: 'forbidden' }),
      );
    } catch {
      /* socket already gone — cleanupSocket handles it */
    }
  }
  return failed;
}

/**
 * Close every socket whose session or API key no longer authenticates — signed
 * out, revoked, expired, its user barred or deleted, its key revoked or its
 * creator barred. One batched lookup for all of them.
 *
 * Closed, not trimmed: the client's reconnect meets the upgrade's 401. A lookup
 * that throws closes nothing and answers `true`, as `revalidateWsSubscriptions`
 * does, so `revalidateSockets` retries.
 */
export async function closeUnauthenticatedWs(): Promise<boolean> {
  const conns = [...connections];
  if (conns.length === 0 || !wsDb) return false;
  let found: Awaited<ReturnType<typeof stillAuthenticated<RealtimePrincipal>>>;
  try {
    found = await stillAuthenticated(
      wsDb,
      conns.flatMap(([, c]) => (c.principal ? [c.principal] : [])),
    );
  } catch (err) {
    console.error('[ws] principal recheck failed; retrying:', err);
    return true;
  }
  let failed = false;
  for (const [connId, conn] of conns) {
    if (!conn.principal || !found.live.has(conn.principal)) {
      // Out of the registry first, so no event reaches it while the close runs.
      cleanupSocket(conn.ws);
      try {
        conn.ws.close(4001, 'Unauthorized');
      } catch {
        /* already closed */
      }
      continue;
    }
    // A key whose scopes or RLS exemption changed since the upgrade: take the
    // grants as they are now and re-check its subscriptions against them —
    // here, whatever the sweep's scope, and past the cached subscribe answers.
    const grants = conn.principal.kind === 'api_key' && found.keys.get(conn.principal.keyId);
    if (
      grants &&
      (JSON.stringify(grants.scopes) !== JSON.stringify(conn.user.scopes) ||
        grants.rlsBypass !== (conn.user.rlsBypass === true))
    ) {
      conn.user = { ...conn.user, scopes: grants.scopes, rlsBypass: grants.rlsBypass };
      wsPermCache.set(conn.ws, new Map());
      if (await recheckSubscriptions(connId, conn)) failed = true;
    }
  }
  return failed;
}

/** Test-only: seed / inspect the in-process WS registries. */
export function _wsPermCacheForTests() {
  // `indexSubscription` is part of the seam because a connection that is in
  // `connections` but not in `subscriptionIndex` receives nothing — a probe
  // that forgot it would pass while the fan-out leaked.
  return { wsPermCache, connections, WS_PERM_CACHE_TTL_MS, indexSubscription };
}

export const websocketHandler = {
  /**
   * Bun defaults this to 16MB, and every byte of it reaches `JSON.parse` in
   * `message` below. The protocol here is subscribe/unsubscribe/ping frames —
   * a few hundred bytes with a long collection list. 64KB is generous for that
   * and takes a cheap memory-amplification lever away from an authenticated
   * client.
   */
  maxPayloadLength: 64 * 1024,

  /**
   * Per-connection send buffer. Bun also defaults this to 16MB but does NOT
   * close on reaching it, so a client that stops reading while subscribed to a
   * busy collection parks 16MB of engine memory for as long as it stays
   * connected. Dropping the socket is the right answer: realtime is a
   * best-effort stream and the client reconnects and resubscribes.
   */
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,

  /**
   * Explicit rather than inherited: this is the only thing reaping half-open
   * sockets from `connections` + `subscriptionIndex`, since a peer that
   * vanishes without a FIN fires neither `close` nor `error`. Bun's own
   * `sendPings` (default true) keeps healthy idle connections under the limit
   * at the protocol layer, so no application-level heartbeat is needed.
   */
  idleTimeout: 120,

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  open(ws: any) {
    const { id, userId, user, tenantId, authType, principal, sweepGen } = ws.data ?? {};
    if (!id || !userId || !principal) {
      // Should never happen — the /api/ws route enforces auth before upgrade.
      ws.close(4001, 'Unauthorized');
      return;
    }

    connections.set(id, {
      userId,
      user: user ?? { id: userId },
      tenantId: tenantId ?? null,
      ws,
      subscriptions: new Set(), // no default subscriptions — clients must explicitly subscribe
      connectedAt: Date.now(),
      authType: authType === 'api_key' ? 'api_key' : 'session',
      principal,
      access: new Map(),
    });
    wsPermCache.set(ws, new Map());
    if (sweepGen !== sweepGeneration()) revalidateSockets('principals');

    ws.send(
      JSON.stringify({
        type: 'connected',
        connectionId: id,
        userId,
        timestamp: Date.now(),
      }),
    );
  },

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  async message(ws: any, message: string | Buffer) {
    const conn = connections.get(ws.data?.id);
    if (!conn) return;

    try {
      const msg = JSON.parse(typeof message === 'string' ? message : message.toString());

      switch (msg.type) {
        case 'subscribe': {
          // Support both { type:'subscribe', collections:['posts','orders'] }
          // and { type:'subscribe', channel:'posts:insert' }
          if (Array.isArray(msg.collections)) {
            const allowed: string[] = [];
            const denied: string[] = [];
            for (const col of msg.collections) {
              if (col === '*') {
                denied.push(col);
                continue;
              }
              const collectionName = typeof col === 'string' ? col.split(':')[0] : null;
              if (!collectionName) {
                denied.push(col);
                continue;
              }

              const canRead = await socketMaySubscribe(ws, conn, collectionName);

              if (canRead) {
                conn.subscriptions.add(col);
                indexSubscription(col, ws.data.id);
                allowed.push(col);
              } else {
                denied.push(col);
              }
            }
            ws.send(JSON.stringify({ type: 'subscribed', collections: allowed, denied }));
          } else if (typeof msg.channel === 'string') {
            if (msg.channel === '*') {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Wildcard subscriptions are not allowed',
                }),
              );
              break;
            }
            const collectionName = msg.channel.split(':')[0];
            const canRead = await socketMaySubscribe(ws, conn, collectionName);
            if (canRead) {
              conn.subscriptions.add(msg.channel);
              indexSubscription(msg.channel, ws.data.id);
              ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
            } else {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: `No read permission for "${collectionName}"`,
                }),
              );
            }
          }
          break;
        }

        case 'unsubscribe': {
          if (Array.isArray(msg.collections)) {
            for (const col of msg.collections) {
              conn.subscriptions.delete(col);
              unindexSubscription(col, ws.data.id);
            }
            ws.send(JSON.stringify({ type: 'unsubscribed', collections: msg.collections }));
          } else if (typeof msg.channel === 'string') {
            conn.subscriptions.delete(msg.channel);
            unindexSubscription(msg.channel, ws.data.id);
            ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
          }
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  },

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  close(ws: any) {
    cleanupSocket(ws);
  },

  // Bun's WebSocket handler fires `error` when the socket dies before
  // `close` runs (e.g. ETIMEDOUT, abrupt TCP RST). Without an explicit
  // handler the connection state lingers in `connections` and
  // `subscriptionIndex` until the next broadcast tries to send and
  // catches a write error. We treat error as a close so cleanup is
  // symmetric and the indices don't leak entries.
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  error(ws: any, err: unknown) {
    console.warn('[ws] socket error:', err instanceof Error ? err.message : String(err));
    cleanupSocket(ws);
  },
};

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
function cleanupSocket(ws: any): void {
  if (ws.data?.id) {
    const conn = connections.get(ws.data.id);
    if (conn) unindexAllSubscriptions(ws.data.id, conn.subscriptions);
    connections.delete(ws.data.id);
  }
  wsPermCache.delete(ws);
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
// Called by data.ts and other routes to push realtime events to subscribers.

/**
 * Broadcast a CRUD event to all WebSocket clients subscribed to the collection.
 * Subscription matching: '*', 'collection_name', or 'collection_name:event'.
 */
export function broadcastEvent(
  collection: string,
  event: 'insert' | 'update' | 'delete',
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  data: any,
  tenantId: string | null = null,
): void {
  const payload = JSON.stringify({ type: 'event', collection, event, data, timestamp: Date.now() });
  const specificChannel = `${collection}:${event}`;
  const wildcardChannel = `${collection}:*`;

  // Use subscription index for O(subscribers) instead of O(all connections)
  const sent = new Set<string>();
  const stale: Array<{ channel: string; connId: string }> = [];
  for (const channel of [collection, wildcardChannel, specificChannel]) {
    const connIds = subscriptionIndex.get(channel);
    if (!connIds) continue;
    for (const connId of connIds) {
      if (sent.has(connId)) continue;
      sent.add(connId);
      const conn = connections.get(connId);
      if (!conn) {
        // Stale index entry — the close/error handler missed it (e.g.
        // the socket was killed by the kernel without firing either).
        // Prune so the index doesn't grow unbounded across reconnects.
        stale.push({ channel, connId });
        continue;
      }
      // Strict tenant isolation — drop the message rather than deliver
      // it cross-tenant. NULL is treated as a distinct value so
      // single-tenant connections aren't fed multi-tenant traffic and
      // vice-versa.
      if ((conn.tenantId ?? null) !== (tenantId ?? null)) continue;

      // The subscriber's own row policies and column permissions, applied by
      // the same helpers the REST and SSE paths use. Without them this door
      // delivered rows the API would have filtered and columns it would have
      // stripped.
      //
      // No entry means nothing resolved what this socket may see, so it gets
      // nothing — not everything. Subscribing always resolves one; this is the
      // backstop for a path that someday does not.
      const access = conn.access.get(collection);
      if (!access) continue;
      if (access.rls.length > 0 && !matchesRlsFilters(data, access.rls)) continue;
      const visible = access.columns ? applyColumnAccess(data, access.columns) : data;
      const body =
        visible === data
          ? payload
          : JSON.stringify({
              type: 'event',
              collection,
              event,
              data: visible,
              timestamp: Date.now(),
            });
      try {
        conn.ws.send(body);
      } catch {
        // Connection dead — close/error will fire eventually and call
        // cleanupSocket. Until then, the next broadcast won't loop
        // forever because `connections.get` returns undefined above.
      }
    }
  }
  for (const { channel, connId } of stale) unindexSubscription(channel, connId);
}

/**
 * Tell every socket subscribed to `SCHEMA_CHANNEL` that a collection was
 * created, altered or dropped. The name and the verb only: no field definitions
 * — a watcher re-reads `/api/collections`, which is gated. No tenant filter:
 * collections are instance-wide (`zvd_collections` has no tenant), so a god on
 * any tenant's host must hear it. Whether each socket may hear it was decided at
 * subscribe and is re-decided by every sweep — that gate is the only filter.
 */
export function broadcastSchemaChange(collection: string, action: SchemaChangeAction): void {
  const connIds = subscriptionIndex.get(SCHEMA_CHANNEL);
  if (!connIds) return;
  const payload = JSON.stringify({
    type: 'schema:changed',
    collection,
    action,
    timestamp: Date.now(),
  });
  for (const connId of connIds) {
    const conn = connections.get(connId);
    if (!conn) continue;
    try {
      conn.ws.send(payload);
    } catch {
      /* socket already gone — cleanupSocket handles it */
    }
  }
}

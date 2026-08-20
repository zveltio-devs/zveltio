import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission, isTenantAdmin } from '../lib/tenancy/index.js';
import { getRlsFilters, matchesRlsFilters } from '../lib/tenancy/index.js';
import { applyColumnAccess, getColumnAccess, resolveUserRole } from '../lib/tenancy/index.js';
import type { ColumnAccess } from '../lib/tenancy/index.js';
/** What `getRlsFilters` returns — no exported alias for it. */
type RlsFilter = Awaited<ReturnType<typeof getRlsFilters>>[number];
import { getCache } from '../lib/runtime/index.js';

// Standard channel names (mirrors old-repo CHANNELS for SDK compatibility)
export const CHANNELS = {
  DATA_CHANGES: 'zveltio:data:*',
  NOTIFICATIONS: 'zveltio:notifications',
  SYSTEM: 'zveltio:system',
  PROACTIVE_AI_ALERTS: 'zveltio:ai:alerts',
  PROACTIVE_AI_SUGGESTIONS: 'zveltio:ai:suggestions',
} as const;

interface SubscriptionFilter {
  field: string;
  op: 'eq' | 'neq' | 'in';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  value: any;
}

interface StreamSub {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  stream: any;
  collections: string[]; // empty = all
  recordId?: string; // filter to specific record ID
  filters: SubscriptionFilter[]; // field-level filters on the record payload
  /**
   * Tenant id at the time the subscription was opened. Required for
   * cross-tenant isolation in `broadcastDataEvent`: without it a
   * subscriber in tenant A would receive every write made to the
   * same-named collection (e.g. `contacts`) in every other tenant.
   * `null` for single-tenant deployments.
   */
  tenantId: string | null;
  /**
   * The non-data channels this subscription was authorized for, exactly as
   * `?channel=` asked for them. `broadcastSSE` fanned out to every open
   * stream without consulting anything, so a presence join in one tenant was
   * delivered to every connected client on the instance — including tenants
   * that had never heard of the channel.
   */
  channels: string[];
  /**
   * Row and column authorisation, resolved once when the stream opened.
   *
   * Subscribing checked `checkPermission(user, collection, 'read')` and nothing
   * else, while the REST list path applies three layers: the permission, the
   * row policies in `zv_rls_policies`, and column permissions. So a user
   * restricted by policy to their own records — the ordinary case the feature
   * exists for — received every write to the collection over SSE, with every
   * column, including ones the API would have stripped. The same collection,
   * read through a different door, answered a different question.
   *
   * Resolved at subscribe time rather than per event: the alternative is two
   * database lookups per subscriber per write. The cost is that a policy change
   * takes effect for an open stream when the client reconnects, which is the
   * same window every long-lived connection has.
   */
  access: Map<string, { rls: RlsFilter[]; columns: ColumnAccess | null }>;
}

// Active SSE connections: userId → Set of subscriptions
const connections = new Map<string, Set<StreamSub>>();

/**
 * Redis channel name, namespaced by tenant.
 *
 * Channel names are user-facing strings: `zveltio:presence:standup` means the
 * same thing in every tenant, so with one Valkey behind several engine
 * instances a publish in tenant A was delivered to subscribers in tenant B.
 * In-process delivery was already tenant-checked; the cache path was the way
 * around it. `null` (single-tenant) keeps the bare name so existing
 * deployments and any external subscriber keep working.
 */
function busChannel(tenantId: string | null, channel: string): string {
  return tenantId ? `t:${tenantId}:${channel}` : channel;
}

/** Undo `busChannel` — the message handler needs the logical name back. */
function stripBusNamespace(channel: string): string {
  return channel.replace(/^t:[0-9a-fA-F-]{36}:/, '');
}

function ctxTenantId(c: Context): string | null {
  return (c.get('tenant') as { id?: string } | null)?.id ?? null;
}

// ── Presence ──────────────────────────────────────────────────────────────────
// In-memory fallback when Valkey is unavailable: channel → Map<userId, lastSeen>
const presenceStore = new Map<string, Map<string, number>>();
const PRESENCE_TTL_MS = 60_000; // consider user offline after 60s without heartbeat

function presenceCleanup(channel: string) {
  const members = presenceStore.get(channel);
  if (!members) return;
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [uid, ts] of members) {
    if (ts < cutoff) members.delete(uid);
  }
  if (members.size === 0) presenceStore.delete(channel);
}

/**
 * The Valkey key a channel's presence set lives under.
 *
 * It was `presence:${channel}`, with no tenant in it. Channel names are
 * user-facing strings, so two tenants that both have a `standup` channel shared
 * one set: each saw the other's members join and leave, with the userId and the
 * display metadata attached. The SSE bus was carefully tenant-scoped; the store
 * behind it was not.
 *
 * A function rather than three template literals, because the bug was that one
 * of three places could differ — and two of them did not even take a tenant.
 */
function presenceKey(tenantId: string | null, channel: string): string {
  return `presence:${tenantId ?? 'default'}:${channel}`;
}

/**
 * The Valkey key a member's display metadata lives under.
 *
 * The comment above says the fix was a function "because the bug was that one
 * of three places could differ". It was written while three template literals
 * for THIS key were left in place, one line below — same bug, same function,
 * untouched. The set got a tenant and the metadata beside it did not.
 *
 * Nothing reads this hash today, so the omission disclosed nothing: the key
 * carries a userId and the value is that user's own name and email. It is
 * being fixed because the first feature that reads it back — showing names in
 * a presence list, the obvious next step — turns a dormant inconsistency into
 * a cross-tenant leak, and whoever writes that reader will have no reason to
 * suspect the key underneath them is unscoped.
 */
function presenceMetaKey(tenantId: string | null, channel: string, userId: string): string {
  return `presence_meta:${tenantId ?? 'default'}:${channel}:${userId}`;
}

/**
 * Test seam for the presence key shape.
 *
 * Exported rather than reached through a `mock.module` on the runtime: mocking
 * `getCache` globally replaces it for every other test file in the same
 * `bun test` run — measured at 53 unrelated failures — and these functions
 * already take the cache as their first argument, so no mock is needed to
 * observe what they write.
 */
export const _presenceInternals = {
  join: (...args: Parameters<typeof presenceJoin>) => presenceJoin(...args),
  leave: (...args: Parameters<typeof presenceLeave>) => presenceLeave(...args),
};

async function presenceJoin(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  cache: any,
  tenantId: string | null,
  channel: string,
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  meta: Record<string, any>,
) {
  const ts = Date.now();
  if (cache) {
    try {
      const key = presenceKey(tenantId, channel);
      await cache.zadd(key, ts, userId);
      await cache.pexpire(key, PRESENCE_TTL_MS * 2);
      // Store user meta as hash
      const metaKey = presenceMetaKey(tenantId, channel, userId);
      await cache.hset(metaKey, meta);
      await cache.pexpire(metaKey, PRESENCE_TTL_MS * 2);
      return;
    } catch {
      /* fall through to in-memory */
    }
  }
  if (!presenceStore.has(channel)) presenceStore.set(channel, new Map());
  presenceStore.get(channel)!.set(userId, ts);
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function presenceLeave(cache: any, tenantId: string | null, channel: string, userId: string) {
  if (cache) {
    try {
      await cache.zrem(presenceKey(tenantId, channel), userId);
      await cache.del(presenceMetaKey(tenantId, channel, userId));
      return;
    } catch {
      /* fall through */
    }
  }
  presenceStore.get(channel)?.delete(userId);
}

async function presenceList(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  cache: any,
  tenantId: string | null,
  channel: string,
): Promise<Array<{ userId: string; lastSeen: number }>> {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  if (cache) {
    try {
      const key = presenceKey(tenantId, channel);
      await cache.zremrangebyscore(key, 0, cutoff);
      const members: string[] = await cache.zrange(key, 0, -1, 'WITHSCORES');
      const result: Array<{ userId: string; lastSeen: number }> = [];
      for (let i = 0; i < members.length; i += 2) {
        result.push({ userId: members[i], lastSeen: parseInt(members[i + 1]) });
      }
      return result;
    } catch {
      /* fall through */
    }
  }
  presenceCleanup(channel);
  const members = presenceStore.get(channel);
  if (!members) return [];
  return [...members.entries()].map(([userId, lastSeen]) => ({ userId, lastSeen }));
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function matchesSub(sub: StreamSub, collection: string, record: any): boolean {
  if (sub.collections.length > 0 && !sub.collections.includes(collection)) return false;
  if (sub.recordId && record?.id !== sub.recordId) return false;
  for (const f of sub.filters) {
    const val = record?.[f.field];
    if (f.op === 'eq' && val !== f.value) return false;
    if (f.op === 'neq' && val === f.value) return false;
    if (f.op === 'in' && (!Array.isArray(f.value) || !f.value.includes(val))) return false;
  }
  return true;
}

/**
 * Broadcast a data event — applies per-subscription filtering before
 * sending. `tenantId` constrains delivery to subscribers that opened
 * their stream under the same tenant; pass `null` only for legacy
 * single-tenant deployments. Without this scoping, a subscriber to
 * `contacts` in tenant A would receive every contact write made in
 * every tenant (the SSE stream and the cache channel name both use
 * just the collection slug).
 */
export function broadcastDataEvent(
  collection: string,
  event: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  record: any,
  tenantId: string | null = null,
): void {
  const payload = JSON.stringify({
    channel: `zveltio:data:${collection}`,
    event,
    collection,
    data: record,
    timestamp: new Date().toISOString(),
  });

  for (const [, subs] of connections) {
    for (const sub of subs) {
      // Strict tenant scoping. Cross-tenant delivery is a data leak,
      // so we require equality (no NULL-matches-anything).
      if ((sub.tenantId ?? null) !== (tenantId ?? null)) continue;
      if (!matchesSub(sub, collection, record)) continue;

      // The subscriber's own row policies, applied by the same helper the REST
      // list path uses. Without this the stream delivered rows the API would
      // have filtered out.
      const access = sub.access.get(collection);
      if (access && access.rls.length > 0 && !matchesRlsFilters(record, access.rls)) continue;

      // Column permissions too — a masked field must not arrive over SSE
      // just because it arrived as an event rather than as a response.
      const visible = access?.columns ? applyColumnAccess(record, access.columns) : record;
      const body =
        visible === record
          ? payload
          : JSON.stringify({
              channel: `zveltio:data:${collection}`,
              event,
              collection,
              data: visible,
              timestamp: new Date().toISOString(),
            });
      try {
        sub.stream.writeSSE({ data: body, event: 'data' });
      } catch {
        /* client disconnected */
      }
    }
  }
}

/**
 * Broadcast a generic (non-data) event to the clients subscribed to `channel`.
 *
 * It used to write to every open stream — every user, every tenant, whatever
 * they had subscribed to. Presence join/leave carries a userId and a display
 * name, and `POST /realtime/broadcast` carries an arbitrary payload, so this
 * handed both to unrelated tenants. The `?channel=` authorization added to the
 * subscribe route decided who *may* receive a channel; nothing then applied
 * that decision at delivery.
 *
 * `tenantId` scopes delivery the way `broadcastDataEvent` does. Equality is
 * required in both directions: null does not match a tenant.
 */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function broadcastSSE(
  channel: string,
  event: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  data: any,
  tenantId: string | null = null,
): void {
  const payload = JSON.stringify({
    channel,
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const [, subs] of connections) {
    for (const sub of subs) {
      if ((sub.tenantId ?? null) !== (tenantId ?? null)) continue;
      if (!sub.channels.includes(channel)) continue;
      try {
        sub.stream.writeSSE({ data: payload, event });
      } catch {
        /* client disconnected */
      }
    }
  }
}

/** Parse ?filter={"status":"published"} or ?filter={"price":{"gt":50}} into SubscriptionFilter[] */
function parseSubFilters(raw: string | undefined): SubscriptionFilter[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).map(([field, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        const [op, val] = Object.entries(value)[0] as [string, any];
        const mappedOp = op === 'neq' ? 'neq' : op === 'in' ? 'in' : 'eq';
        return { field, op: mappedOp, value: val };
      }
      return { field, op: 'eq' as const, value };
    });
  } catch {
    return [];
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function realtimeRoutes(_db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET /stream — SSE endpoint for real-time updates
  // Query params:
  //   ?collection=col1,col2          — subscribe to data collections (empty = all data)
  //   ?channel=broadcast:x,presence:y — subscribe to broadcast/presence channels
  //   ?record_id=uuid                — only events for this record
  //   ?filter={"field":"value"}      — field-level filter on record payload
  app.get('/stream', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const userId = session.user.id;
    const rawCollections = c.req.query('collection')?.split(',').filter(Boolean) ?? [];
    const extraChannels =
      c.req
        .query('channel')
        ?.split(',')
        .filter(Boolean)
        .map((ch) => (ch.startsWith('zveltio:') ? ch : `zveltio:${ch}`)) ?? [];
    const recordId = c.req.query('record_id') || undefined;
    const filters = parseSubFilters(c.req.query('filter'));

    // Permission gate — caller must have data:<collection>:read for every
    // collection they want to stream. Without this, a curl with the
    // session cookie could subscribe to zvd_users / account and receive a
    // mirror of every write that happens there in real time. ws.ts
    // already enforces the same check; realtime.ts (SSE) was missing it.
    //
    // Wildcard streaming (empty collections) is also gated: it's only
    // allowed for admins, since otherwise it would expose data from every
    // collection in the system to any authenticated user.
    if (rawCollections.length === 0) {
      const isAdmin = await isTenantAdmin(userId).catch(() => false);
      if (!isAdmin) {
        return c.json(
          {
            error: 'Wildcard collection streams require admin; specify ?collection=name1,name2',
          },
          403,
        );
      }
    }
    const collections: string[] = [];
    const denied: string[] = [];
    for (const col of rawCollections) {
      // Collection channel may carry an `:event` suffix (e.g. "orders:insert").
      const base = col.split(':')[0];
      // Reject obviously invalid names early so they never hit Casbin
      if (!base || !/^[a-zA-Z0-9_]+$/.test(base)) {
        denied.push(col);
        continue;
      }
      const canRead = await checkPermission(userId, base, 'read').catch(() => false);
      if (canRead) {
        collections.push(col);
      } else {
        denied.push(col);
      }
    }
    if (collections.length === 0 && rawCollections.length > 0) {
      return c.json(
        {
          error: 'No read permission on any of the requested collections',
          denied,
        },
        403,
      );
    }

    // `?channel=` used to be forwarded to Redis unchecked, while `?collection=`
    // went through Casbin above. Since a bare channel is prefixed with
    // `zveltio:`, `?channel=data:zvd_salaries` produced exactly the channel the
    // collection gate exists to protect — the same subscription, one query
    // parameter to the left.
    //
    // A `data:<collection>` channel now needs read on that collection, like any
    // other way of asking for it. Anything else is an internal or
    // extension-owned channel whose contents this route cannot reason about, so
    // it requires instance admin: fail closed on the unknown rather than
    // enumerate what happens to be sensitive today.
    const allowedExtraChannels: string[] = [];
    for (const ch of extraChannels) {
      const dataMatch = /^zveltio:data:([a-zA-Z0-9_]+)(?::[a-zA-Z0-9_]+)?$/.exec(ch);
      if (dataMatch) {
        if (await checkPermission(userId, dataMatch[1], 'read').catch(() => false)) {
          allowedExtraChannels.push(ch);
        } else {
          denied.push(ch);
        }
        continue;
      }
      if (await isTenantAdmin(userId).catch(() => false)) {
        allowedExtraChannels.push(ch);
      } else {
        denied.push(ch);
      }
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const tenantId = (c.get('tenant') as any)?.id ?? null;

    // Resolve row + column authorisation for every collection this stream may
    // deliver, once, here. The delivery loop is synchronous and runs per write
    // per subscriber, so it cannot go to the database; and `checkPermission`
    // alone — which is all this route used to do — is one of the three layers
    // the REST path applies.
    const user = { id: userId, role: (session.user as { role?: string }).role ?? 'user' };
    const access = new Map<string, { rls: RlsFilter[]; columns: ColumnAccess | null }>();
    const authType = c.get('authType');
    const role = await resolveUserRole(user).catch(() => 'user');
    for (const col of new Set(collections.map((x) => x.split(':')[0]!))) {
      access.set(col, {
        rls: await getRlsFilters(col, user, authType).catch(() => []),
        columns: await getColumnAccess(_db, col, role).catch(() => null),
      });
    }

    return streamSSE(c, async (stream) => {
      const sub: StreamSub = {
        stream,
        collections,
        recordId,
        filters,
        tenantId,
        channels: allowedExtraChannels,
        access,
      };

      if (!connections.has(userId)) connections.set(userId, new Set());
      const userSubs = connections.get(userId)!;
      userSubs.add(sub);

      // Subscribe to cache channels if cache is available
      const cache = getCache();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      let subscriber: any = null;

      if (cache) {
        try {
          subscriber = cache.duplicate();
          const dataChannels =
            collections.length > 0
              ? collections.map((col) => `zveltio:data:${col}`)
              : [CHANNELS.DATA_CHANGES];
          // Namespaced by tenant. Without this the subscription was to a
          // channel whose name is the same in every tenant, so one Valkey
          // shared by several engine instances delivered other tenants'
          // writes here — the one path around the tenant check that
          // `broadcastDataEvent` applies in-process.
          const channels = [...dataChannels, ...allowedExtraChannels].map((ch) =>
            busChannel(tenantId, ch),
          );

          await subscriber.subscribe(...channels);

          subscriber.on('message', (_channel: string, message: string) => {
            try {
              // Per-record / per-filter: parse message and check before forwarding
              if (recordId || filters.length > 0) {
                const parsed = JSON.parse(message);
                const col =
                  parsed?.collection ?? stripBusNamespace(_channel).replace('zveltio:data:', '');
                if (!matchesSub(sub, col, parsed?.data ?? parsed)) return;
              }
              stream.writeSSE({ data: message, event: 'data' });
            } catch {
              /* stream closed or malformed message */
            }
          });
        } catch {
          /* Redis unavailable — in-process broadcastDataEvent still works */
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          userId,
          collections,
          denied,
          channels: allowedExtraChannels,
          record_id: recordId ?? null,
          filters,
          timestamp: new Date().toISOString(),
        }),
        event: 'connected',
      });

      const pingInterval = setInterval(() => {
        stream.writeSSE({ data: 'ping', event: 'ping' }).catch(() => {});
      }, 30_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(async () => {
          clearInterval(pingInterval);
          userSubs.delete(sub);
          if (userSubs.size === 0) connections.delete(userId);
          if (subscriber) {
            try {
              await subscriber.unsubscribe();
              await subscriber.disconnect();
            } catch {
              /* ignore */
            }
          }
          resolve();
        });
      });
    });
  });

  // ── Presence ───────────────────────────────────────────────────
  // POST /presence/:channel — Join a presence channel (or send heartbeat)
  app.post('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');
    const meta = await c.req.json().catch(() => ({}));
    const cache = getCache();

    // Client metadata first, identity last.
    //
    // These were the other way round, so `...meta` — the request body —
    // overwrote `name` and `email`. The userId is a separate argument and was
    // never forgeable, which is what made this easy to wave away: I said as
    // much in an earlier pass and was wrong. The id was safe and the display
    // name was not, and a presence list is read by people, who see the name.
    await presenceJoin(cache, ctxTenantId(c), channel, session.user.id, {
      ...meta,
      name: session.user.name,
      email: session.user.email,
    });

    // Broadcast join event to all channel subscribers
    const presenceTenant = ctxTenantId(c);
    broadcastSSE(
      `zveltio:presence:${channel}`,
      'presence.join',
      {
        channel,
        userId: session.user.id,
        user: { name: session.user.name },
        timestamp: new Date().toISOString(),
      },
      presenceTenant,
    );
    if (cache) {
      try {
        await cache.publish(
          busChannel(presenceTenant, `zveltio:presence:${channel}`),
          JSON.stringify({
            event: 'presence.join',
            channel,
            userId: session.user.id,
            timestamp: Date.now(),
          }),
        );
      } catch {
        /* non-fatal */
      }
    }

    return c.json({ success: true, channel });
  });

  // DELETE /presence/:channel — Leave a presence channel
  app.delete('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');
    const cache = getCache();

    await presenceLeave(cache, ctxTenantId(c), channel, session.user.id);

    const presenceTenant = ctxTenantId(c);
    broadcastSSE(
      `zveltio:presence:${channel}`,
      'presence.leave',
      {
        channel,
        userId: session.user.id,
        timestamp: new Date().toISOString(),
      },
      presenceTenant,
    );
    if (cache) {
      try {
        await cache.publish(
          busChannel(presenceTenant, `zveltio:presence:${channel}`),
          JSON.stringify({
            event: 'presence.leave',
            channel,
            userId: session.user.id,
            timestamp: Date.now(),
          }),
        );
      } catch {
        /* non-fatal */
      }
    }

    return c.json({ success: true });
  });

  // GET /presence/:channel — List users in a channel
  app.get('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');

    // Joining announces yourself; LISTING tells you who else is there, and a
    // channel name usually says what "there" is. `zvd_salaries` or
    // `record:zvd_salaries:<id>` would otherwise let any member learn who is
    // looking at a salary record — the roster is the disclosure, not the join.
    //
    // Only channels that name a collection are gated, and on read of that
    // collection: an ad-hoc room name discloses nothing but its own existence,
    // and requiring a permission for one would end the collaboration feature
    // this exists for.
    const named = /^(?:record:)?(zvd_[a-z0-9_]+)(?::|$)/i.exec(channel);
    if (named) {
      const collection = named[1].replace(/^zvd_/, '');
      if (!(await checkPermission(session.user.id, collection, 'read').catch(() => false))) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    const cache = getCache();
    const members = await presenceList(cache, ctxTenantId(c), channel);
    return c.json({ channel, members });
  });

  // ── Broadcast channels ─────────────────────────────────────────
  // POST /broadcast/:channel — Publish a message to a custom channel
  // Any authenticated user can publish; clients subscribe via SSE ?channel=broadcast:name
  app.post('/broadcast/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    // Sending and receiving now need the same thing.
    //
    // Subscribing to a non-data channel requires tenant admin (see the
    // `?channel=` gate above); sending to one required only a session. The
    // blast radius was narrow — the name is forced into `zveltio:broadcast:`
    // so it cannot reach a data channel, and only admins could hear it — but
    // "any member may push a message that only admins receive" is a nuisance
    // path with no legitimate caller: nothing in the Studio or the SDK uses
    // this route.
    if (!(await isTenantAdmin(session.user.id).catch(() => false))) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const channel = c.req.param('channel');
    if (channel.length > 128) return c.json({ error: 'Channel name too long' }, 400);

    const body = await c.req.json().catch(() => null);
    if (!body?.event || !body?.payload) {
      return c.json({ error: 'event and payload are required' }, 400);
    }

    const broadcastChannel = `zveltio:broadcast:${channel}`;
    const message = {
      channel: broadcastChannel,
      event: body.event,
      payload: body.payload,
      senderId: session.user.id,
      timestamp: new Date().toISOString(),
    };

    const cache = getCache();
    if (cache) {
      try {
        await cache.publish(busChannel(ctxTenantId(c), broadcastChannel), JSON.stringify(message));
      } catch {
        /* non-fatal */
      }
    }

    broadcastSSE(broadcastChannel, body.event, message, ctxTenantId(c));

    return c.json({ success: true, channel: broadcastChannel });
  });

  // GET /connections — Admin: list active SSE connections
  app.get('/connections', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    // The comment above said "Admin" and the code checked only for a session,
    // so any member could enumerate every connected userId on the instance.
    // `/api/ws/stats` next door already gates the same information this way.
    if (!(await isTenantAdmin(session.user.id).catch(() => false))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return c.json({
      connections: connections.size,
      users: [...connections.keys()].map((id) => ({
        userId: id,
        streams: connections.get(id)?.size ?? 0,
      })),
    });
  });

  // POST /publish — Admin: publish a custom event to all SSE clients
  app.post('/publish', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const isAdmin = await isTenantAdmin(session.user.id);
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body?.channel || !body?.payload) {
      return c.json({ error: 'channel and payload are required' }, 400);
    }

    const cache = getCache();
    if (cache) {
      try {
        await cache.publish(
          busChannel(ctxTenantId(c), body.channel),
          JSON.stringify({
            payload: body.payload,
            userId: session.user.id,
            timestamp: Date.now(),
          }),
        );
      } catch {
        /* non-fatal */
      }
    }

    broadcastSSE(body.channel, body.event ?? 'message', body.payload, ctxTenantId(c));

    return c.json({ success: true });
  });

  return app;
}

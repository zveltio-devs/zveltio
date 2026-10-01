/**
 * Authentication + per-collection authorization for the CRUD data path
 * (H-05 split of `routes/data.ts`).
 *
 * `authenticate` resolves a session (better-auth) or API key into a
 * `RequestUser`; `checkAccess` enforces API-key scopes and delegates
 * everything else to `checkPermission` (god bypass + Casbin). Byte-identical
 * to the pre-split inline helpers — zero behaviour change.
 */

import { publishApiKeyActor } from '../tenancy/index.js';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import type { ZvApiKeyRow } from '../../db/schema.js';
import { requestSession } from '../../middleware/session-prefetch.js';
import { apiKeyActsIn, checkPermission, DEFAULT_TENANT_ID } from '../tenancy/index.js';
import { hashApiKey, isWellFormedApiKey } from '../security/index.js';
import type { RequestUser } from './types.js';

/** Authenticate request — session or API key. */
export async function authenticate(
  c: Context,
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in hardening plan item H-05
  auth: any,
  db: Database,
): Promise<{ user: RequestUser; authType: string; sessionToken?: string } | null> {
  // Try session — the prefetch resolved it before the tenant transaction opened.
  //
  // Asking here directly is what produced `permission denied for table session`:
  // by this point the connection runs as `zveltio_rls`, which cannot read Better
  // Auth's tables, and the refusal aborts the transaction rather than merely
  // failing this lookup. `undefined` means the prefetch did not run (a route
  // mounted outside it), so the direct call stays as the fallback.
  const session = await requestSession(c, auth);
  // The token rides along for a caller that outlives the request — a realtime
  // socket re-asks with it whether the session still exists.
  if (session)
    return { user: session.user, authType: 'session', sessionToken: session.session?.token };

  // Try API key
  const rawKey = requestApiKey(c);

  if (rawKey) {
    // Defensive: a context without `get` (partial mocks, any future caller
    // that builds one by hand) must not throw here. A hardening check that
    // crashes the authentication path is worse than the gap it closes — it
    // fails every request instead of the wrong ones.
    const hasGet = typeof c.get === 'function';
    const requestTenantId = hasGet
      ? ((c.get('tenant') as { id?: string } | null)?.id ?? null)
      : null;
    const prefetchedKey = hasGet ? c.get('prefetchedApiKey') : undefined;
    const apiKey = await validateApiKey(db, rawKey, requestTenantId, prefetchedKey);
    if (apiKey) {
      // `validateApiKey` has already published this actor to the database.
      const bypass = (apiKey as { rls_bypass?: boolean }).rls_bypass === true;
      return {
        user: {
          id: `apikey:${apiKey.id}`,
          name: apiKey.name,
          role: 'api_key',
          // Pass scopes through so checkAccess() can enforce them per collection/action.
          scopes: apiKey.scopes,
          // Per-key RLS exemption (migration 026, default flipped in 032,
          // existing keys backfilled in 040).
          //
          // `=== true`, not `!== false`. The column is NOT NULL today, so the
          // two agree — but they disagree about every state that is neither: a
          // NULL introduced by a later migration, a row assembled by a code path
          // that omits the field, a cache entry deserialised without it. Under
          // `!== false` each of those grants the key instance-wide reads.
          // Exempting a key from tenant isolation should require the database to
          // say so, not merely to fail to deny it.
          rlsBypass: bypass,
          // Authorship goes to the person who issued the key — `user.id` here
          // is `apikey:<uuid>`, which is not a row in `user`.
          authorUserId: (apiKey as { created_by?: string | null }).created_by ?? null,
        },
        authType: 'api_key',
      };
    }
  }

  return null;
}

/**
 * Resolve a raw API key to its row, or null.
 *
 * Exported because every route that accepts `X-API-Key` needs the *same*
 * checks. Edge functions grew their own copy — a hash lookup plus `is_active`
 * and expiry — which left out the tenant comparison below, so a key issued in
 * one tenant invoked another tenant's functions. A second implementation of an
 * auth check is a second place for one to go missing; there is one here now.
 */
/**
 * Who a write is recorded as, which is not always who made it.
 *
 * `created_by`/`updated_by` are foreign keys into `user`. A session principal's
 * id is such a row; an API key's is `apikey:<uuid>` and is not, so every
 * key-authenticated create and update was refused by the database with
 * `23503 foreign_key_violation` — the wizard hands out a key to write with and
 * the key could not write. Authorship for a key falls to the person who issued
 * it, and to NULL when that is unknown, which the column allows.
 */
export function rowAuthorId(user: { id: string; authorUserId?: string | null }): string | null {
  return isApiKeyPrincipal(user) ? (user.authorUserId ?? null) : user.id;
}

/**
 * Is this principal an API key? By its id, which only `authenticate` mints —
 * never by `role`: that is a column on `"user"`, and a session carrying
 * `role: 'api_key'` must not be read as a key (nor skip what a key skips).
 */
export function isApiKeyPrincipal(user: { id: string }): boolean {
  return user.id.startsWith('apikey:');
}

/** The request's `zvk_` key, from `X-API-Key` or a bearer header; null when none. */
export function requestApiKey(c: Context): string | null {
  const raw = c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
  return raw?.startsWith('zvk_') ? raw : null;
}

/**
 * An active, unexpired key row for `rawKey`, or null. No tenant check — see
 * validateApiKey.
 *
 * Refused too when the user who created the key is barred from signing in
 * (`"user".banned`, set by SCIM deactivation): a deactivated employee's keys
 * kept reading and writing after every sign-in method was closed to them. In the
 * same query, so it fails the way the key lookup does — a thrown error, never a
 * key. Deleting the creator revokes their keys (`deleteUser`, migration 025
 * for the ones deleted before), so a NULL `created_by` is no longer a live key.
 */
export async function findApiKey(db: Database, rawKey: string): Promise<ZvApiKeyRow | null> {
  // No query for a string no key can match: `generateApiKey` owns the shape.
  if (!isWellFormedApiKey(rawKey)) return null;
  const hash = await hashApiKey(rawKey);
  const apiKey = await usableApiKeys(db)
    .selectAll('zv_api_keys')
    .where('key_hash', '=', hash)
    .executeTakeFirst();

  if (!apiKey) return null;
  if (apiKeyExpired(apiKey)) return null;
  return apiKey;
}

/** Active keys whose creator is not barred — `findApiKey` and the realtime recheck. */
function usableApiKeys(db: Database) {
  return db
    .selectFrom('zv_api_keys')
    .where('is_active', '=', true)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('user')
            .select('user.id')
            .whereRef('user.id', '=', 'zv_api_keys.created_by')
            .where('user.banned', '=', true),
        ),
      ),
    );
}

function apiKeyExpired(key: { expires_at: unknown }): boolean {
  return key.expires_at != null && new Date(key.expires_at as string) < new Date();
}

/** What a realtime connection authenticated as — kept so the sweep can ask again. */
export type RealtimePrincipal =
  | { kind: 'session'; token: string; userId: string }
  | { kind: 'api_key'; keyId: string };

/**
 * Who a realtime connection reads as: the fields `checkAccess` and
 * `getRlsFilters` look at — a key's `scopes` and `rlsBypass`, a session's email
 * (a `user_email` row rule resolves from it).
 */
export type RealtimeUser = Pick<RequestUser, 'id' | 'email' | 'scopes' | 'rlsBypass'> & {
  role?: string;
};

/**
 * What a realtime door — `/api/ws` and `/api/realtime/stream` — keeps from
 * `authenticate` for as long as its connection is open: the principal the sweep
 * re-asks (`stillAuthenticated`) and the user its read checks see. Null for a
 * session without its token, which the sweep could never re-ask; the door
 * refuses it.
 */
export function realtimeIdentity(
  p: NonNullable<Awaited<ReturnType<typeof authenticate>>>,
): { principal: RealtimePrincipal; user: RealtimeUser; authType: 'session' | 'api_key' } | null {
  if (p.authType === 'api_key') {
    return {
      authType: 'api_key',
      principal: { kind: 'api_key', keyId: p.user.id.replace(/^apikey:/, '') },
      user: { id: p.user.id, role: 'api_key', scopes: p.user.scopes, rlsBypass: p.user.rlsBypass },
    };
  }
  if (!p.sessionToken) return null;
  return {
    authType: 'session',
    principal: { kind: 'session', token: p.sessionToken, userId: p.user.id },
    user: { id: p.user.id, email: p.user.email },
  };
}

/**
 * Which of `principals` would still authenticate now. A socket or stream is
 * authenticated once, at open, so without this a revoked session, a barred or
 * deleted user and a revoked or expired key kept receiving data for as long as
 * the connection stayed up.
 *
 * Sessions are asked through better-auth's own `findSessions` — Valkey first
 * when it is configured, else the table, expired ones excluded — because that
 * is where it looks; a SQL read of `session` misses every session held only in
 * the cache. The user is read from the table: the cached copy of a session
 * carries the user as it was at sign-in, before any ban. Keys go through the
 * same predicate as `findApiKey`. One lookup per kind, whatever the count.
 *
 * `keys` carries each live key's grants as they are now: a connection
 * snapshots them at open, so a key narrowed since kept its old reach.
 *
 * Throws when a lookup fails — that is not a revocation.
 */
export async function stillAuthenticated<P extends RealtimePrincipal>(
  db: Database,
  principals: P[],
): Promise<{ live: Set<P>; keys: Map<string, ApiKeyGrants> }> {
  const all: RealtimePrincipal[] = principals;
  const sessions = all.flatMap((p) => (p.kind === 'session' ? [p] : []));
  const keyIds = [...new Set(all.flatMap((p) => (p.kind === 'api_key' ? [p.keyId] : [])))];
  const liveTokens = new Set<string>();
  const liveUsers = new Set<string>();
  const liveKeys = new Map<string, ApiKeyGrants>();
  if (sessions.length > 0) {
    const { getAuth } = await import('../auth.js');
    const ctx = await getAuth().$context;
    const tokens = [...new Set(sessions.map((p) => p.token))];
    const found = await ctx.internalAdapter.findSessions(tokens, { onlyActiveSessions: true });
    for (const s of found) liveTokens.add(s.session.token);
    const users = await db
      .selectFrom('user')
      .select('id')
      .where('id', 'in', [...new Set(sessions.map((p) => p.userId))])
      .where((eb) => eb.or([eb('banned', 'is', null), eb('banned', '=', false)]))
      .execute();
    for (const u of users) liveUsers.add(u.id);
  }
  if (keyIds.length > 0) {
    const keys = await usableApiKeys(db)
      .select([
        'zv_api_keys.id',
        'zv_api_keys.expires_at',
        'zv_api_keys.scopes',
        'zv_api_keys.rls_bypass',
      ])
      .where('zv_api_keys.id', 'in', keyIds)
      .execute();
    for (const k of keys) {
      // `=== true`, as `authenticate` reads it.
      if (!apiKeyExpired(k))
        liveKeys.set(k.id, { scopes: k.scopes, rlsBypass: k.rls_bypass === true });
    }
  }
  const alive = (p: RealtimePrincipal) =>
    p.kind === 'session'
      ? liveTokens.has(p.token) && liveUsers.has(p.userId)
      : liveKeys.has(p.keyId);
  return { live: new Set(principals.filter(alive)), keys: liveKeys };
}

/** A key's reach, in the shape `authenticate` puts on the principal. */
export interface ApiKeyGrants {
  scopes: RequestUser['scopes'];
  rlsBypass: boolean;
}

/**
 * `found` is the row `sessionPrefetch` already looked up for this request's key
 * (`undefined` = not looked up), so the data path does not query the key twice.
 */
export async function validateApiKey(
  db: Database,
  rawKey: string,
  requestTenantId: string | null,
  found?: ZvApiKeyRow | null,
): Promise<ZvApiKeyRow | null> {
  const apiKey = found !== undefined ? found : await findApiKey(db, rawKey);
  if (!apiKey) return null;

  // The key must belong to the tenant this request is acting in. The lookup
  // above is hash-only, so a key issued in tenant A, sent with
  // `X-Tenant-Slug: tenant-b`, authenticated and then read and wrote tenant B's
  // data. Migration 021 added `tenant_id` exactly so this comparison could
  // exist; it scoped the MANAGEMENT routes and left the AUTH path — the one
  // that decides what a request may touch.
  //
  // Root-tenant keys act anywhere, deliberately. Migration 021 backfilled every
  // pre-existing key to root, so a strict match would refuse working keys on
  // upgrade, and a root-tenant key is already an instance-level credential. The
  // reported attack — one ordinary tenant's key reaching another — is refused.
  //
  // A request that resolved NO tenant is a request acting in the root tenant,
  // and is compared as such. It is not a request exempt from the comparison.
  // The distinction was worth a privilege escalation: this check used to carry
  // a `requestTenantId &&` clause, so `null` skipped it entirely and an
  // ordinary tenant's key authenticated — while `tenantId()` in route-db.ts,
  // which every downstream reader uses, resolves the same absence to
  // DEFAULT_TENANT_ID. Two derivations of "the request's tenant" disagreed
  // about the same request, and the permissive one guarded the door. Absent is
  // root here too, so the two now agree, and they agree in the direction that
  // refuses.
  const keyTenantId = (apiKey as { tenant_id?: string | null }).tenant_id ?? null;
  const actingTenantId = requestTenantId ?? DEFAULT_TENANT_ID;
  if (!apiKeyActsIn(keyTenantId, requestTenantId)) {
    console.warn(
      `[api-key] refused: key ${apiKey.id} belongs to tenant ${keyTenantId} but the ` +
        `request is acting in ${actingTenantId}` +
        (requestTenantId === null ? ' (no tenant resolved; treated as root)' : ''),
    );
    return null;
  }

  // Tell the DATABASE who this is, HERE — not in the callers.
  //
  // The row-rule policies read `zveltio.user_id`; a rule whose value does not
  // resolve skips itself. `tenantMiddleware` publishes the actor for sessions,
  // before the transaction opens, but a key is not known then — it is resolved
  // right here, inside the handler. Until this call existed, all key traffic
  // reached the policies with no identity and every rule stood down. The engine
  // still restricted such a request, so it was never a leak; it was the second
  // layer switched off for a whole class of traffic.
  //
  // It lives in this function rather than in `authenticate()` because there are
  // TWO callers — the data API and `routes/edge-functions.ts` — and the second
  // one only ever used the return value as a boolean. Nothing is open today:
  // that route's queries are engine metadata, and its sandbox gets no database
  // handle at all. But the comment forty lines above this one says exactly why
  // that is not good enough: a second implementation of an auth check is a
  // second place for one to go missing. A caller cannot forget what it does not
  // have to remember.
  //
  // Published on the transaction the request already holds, so it asks for no
  // new connection; `publishApiKeyActor` is a no-op where there is no
  // transaction, which is what makes it safe on every path.
  await publishApiKeyActor(
    `apikey:${apiKey.id}`,
    (apiKey as { rls_bypass?: boolean }).rls_bypass === true,
  );

  // Update last_used_at — fire-and-forget; non-blocking on hot path
  db.updateTable('zv_api_keys')
    .set({ last_used_at: new Date() })
    .where('id', '=', apiKey.id)
    .execute()
    .catch((err) => console.error('[validateApiKey] last_used_at update failed:', err));

  return apiKey;
}

/**
 * The scope that lets an API key watch the collection schema: read it from
 * `GET /api/collections` and hear the realtime channel of the same name
 * (`SCHEMA_CHANNEL`). `$` cannot start a collection name, so no data grant can
 * be spelled this way.
 */
const SCHEMA_SCOPE = '$schema';

/** The scope that lets an API key use `/api/storage` — `read`, `create`, `delete`. */
export const STORAGE_SCOPE = '$storage';

/**
 * The scope that lets an API key call `/api/rpc/:fn`: `execute` (or `*`) on
 * every enabled whitelisted function, or the functions it names — see
 * `grantsCall`. The whitelist's `required_role` ranks a session's roles; a key
 * has none, so the scope stands where the rank does.
 */
export const RPC_SCOPE = '$rpc';

/**
 * The scope that lets an API key use extension `name`'s routes declared in its
 * manifest `apiKeyRoutes`: `$ext:<name>`, e.g. `$ext:finance/invoicing`. Its
 * actions are what the `/ext/*` gate asks per route (method-derived) and what
 * the extension's own `ctx.checkPermission` asks — see extension-auth-gate.ts.
 */
export function extScope(name: string): string {
  return `$ext:${name}`;
}

/**
 * May a key with `scopes`, acting in `tenantId`, watch the schema?
 *
 * Only by naming `SCHEMA_SCOPE` with `read` (or `*`) — see `apiKeyHoldsScope`.
 * Only in the root tenant — the rule `requireInstanceAdmin` applies to a root
 * admin, and `apiKeyActsIn` admits no other tenant's key there, so this is also
 * a root-tenant key.
 */
export function apiKeyMayWatchSchema(scopes: unknown, tenantId: string | null): boolean {
  return tenantId === DEFAULT_TENANT_ID && apiKeyHoldsScope(scopes, SCHEMA_SCOPE, 'read');
}

/**
 * Does a key's `scopes` grant `action` on an engine surface — `$schema`,
 * `$storage` — rather than a collection?
 *
 * The entry must NAME the surface: a `*` collection does not reach it, because
 * `*` is the data grant every integration key is minted with, and a surface is
 * not data it was meant to cover. Actions read as `checkAccess` reads them.
 * Unparseable scopes grant nothing.
 */
export function apiKeyHoldsScope(scopes: unknown, scope: string, action: string): boolean {
  let list = scopes;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return false;
    }
  }
  return (
    Array.isArray(list) &&
    list.some(
      (s: { collection?: unknown; actions?: unknown } | null) =>
        s?.collection === scope &&
        Array.isArray(s.actions) &&
        (scope === RPC_SCOPE ? grantsCall(s.actions, action) : grantsAction(s.actions, action)),
    )
  );
}

/**
 * Whether a `$rpc` entry lets a key call function `fn`: `execute` or `*` for
 * every one, otherwise only a function the entry names exactly. No `write`
 * alias here — a function called `create` is granted by naming it, not by
 * `write`. `execute` and `*` are reserved: they always mean every function.
 */
function grantsCall(actions: unknown[], fn: string): boolean {
  return actions.includes('execute') || actions.includes('*') || actions.includes(fn);
}

/**
 * Whether one scope entry's `actions` carry `action`. `write` is what the
 * Studio's key form once offered — the engine never asks for it, so every key
 * made there could read and delete but not create or update. Keys already
 * stored with it mean what the operator ticked.
 */
function grantsAction(actions: unknown[], action: string): boolean {
  return (
    actions.includes(action) ||
    actions.includes('*') ||
    ((action === 'create' || action === 'update') && actions.includes('write'))
  );
}

/**
 * `user` is narrowed to the three fields this function reads, rather than a
 * whole `RequestUser`. It never looks at `name`, and demanding one obliged
 * every caller outside the data path — `content/pages` renders collections
 * through `ctx.internals.checkAccess` — to invent a value that is discarded.
 * Which branch is decided by the id (`isApiKeyPrincipal`), not by `role`.
 */
export async function checkAccess(
  db: Database,
  user: Pick<RequestUser, 'id' | 'scopes'> & { role?: string },
  collection: string,
  action: string,
): Promise<boolean> {
  // Note: never short-circuit on `user.role === 'admin'`. Better-Auth doesn't
  // populate `role` on the session for magic-link / OAuth flows, so we route
  // every check through checkPermission() — it handles god bypass (DB + HMAC
  // cache) first, then Casbin, so admins with proper policies still get
  // access without depending on a session field that may be missing.
  if (isApiKeyPrincipal(user)) {
    // No system-table check here: a collection name only ever reaches the
    // database as `DDLManager.getTableName(name)` = `zvd_<name>`, so a key
    // cannot name a `zv_` table (pinned in data-auth-checkAccess.test.ts).

    // Scopes format: Array<{ collection: string; actions: string[] }>.
    //
    // An EMPTY array is DENY-ALL. It used to be full access: the guard was
    // `if (scopes.length > 0) { ...enforce... }` followed by `return true`, so an
    // empty list skipped enforcement altogether — and both the create route and
    // the column defaulted to `[]`. `POST /api/api-keys {"name":"x"}` minted a
    // permanent, tenant-wide data credential.
    //
    // The old comment said "Empty array = full access (backwards-compatible
    // default)", which is the defect written down. To anyone filling in a form,
    // "no permissions selected" means "cannot do anything", and the operator most
    // likely to leave it blank is the one aiming for least privilege.
    //
    // Migration 045 wrote the existing keys' access down explicitly before this
    // flipped, so no key already issued lost anything.
    //
    // Wildcard collection '*' or action '*' still grants broad access — it just
    // has to be said out loud now.
    //
    // A malformed JSON blob in `scopes` used to crash the auth check
    // (uncaught JSON.parse). Fail closed — if we can't tell what the key
    // is allowed to do, refuse. The API key remains usable once an admin
    // fixes the row.
    const rawScopes = user.scopes;
    if (rawScopes) {
      let scopes: Array<{ collection: string; actions: string[] }> = [];
      if (typeof rawScopes === 'string') {
        try {
          scopes = JSON.parse(rawScopes);
        } catch (err) {
          console.warn(
            `[auth] api_key ${user.id} has unparseable scopes JSON — refusing access:`,
            (err as Error).message,
          );
          return false;
        }
      } else {
        scopes = rawScopes as Array<{ collection: string; actions: string[] }>;
      }
      if (!Array.isArray(scopes)) {
        console.warn(`[auth] api_key ${user.id} scopes is not an array — refusing access`);
        return false;
      }
      if (scopes.length === 0) {
        console.warn(
          `[auth] api_key ${user.id} has no scopes — refusing ${action} on ${collection}. ` +
            'Grant it explicitly, or [{"collection":"*","actions":["*"]}] for full access.',
        );
        return false;
      }
      // EVERY matching entry, not the first one.
      //
      // This was `scopes.find(...)`, which stops at the first entry naming the
      // collection or `*` and then decides on that one alone. So
      // `[{"collection":"*","actions":["read"]},
      //   {"collection":"posts","actions":["create"]}]`
      // refused `create` on posts -- the wildcard matched first, did not carry
      // the action, and the explicit grant below it was never read. The same two
      // entries in the other order allowed it. Measured, both.
      //
      // Scopes are a list of grants, and a list of grants is a union: nothing in
      // the admin UI or the stored shape suggests that writing a broad read
      // permission first takes away the specific ones under it. An operator
      // adding `{"collection":"*","actions":["read"]}` to an existing key to
      // widen its reads would have silently narrowed everything else.
      const matches = scopes.filter((s) => s.collection === collection || s.collection === '*');
      if (matches.length === 0) return false;
      return matches.some((m) => grantsAction(m.actions, action));
    }
    // No `scopes` value at all (a NULL column) says the same thing an empty list
    // says: nothing was granted.
    console.warn(`[auth] api_key ${user.id} has no scopes at all — refusing access`);
    return false;
  }
  return checkPermission(user.id, collection, action);
}

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
import { DDLManager } from './ddl-manager.js';
import { checkPermission, DEFAULT_TENANT_ID } from '../tenancy/index.js';
import { hashApiKey } from '../security/index.js';
import type { RequestUser } from './types.js';

/** Authenticate request — session or API key. */
export async function authenticate(
  c: Context,
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in docs/private/HARDENING-9-PLAN.md H-05
  auth: any,
  db: Database,
): Promise<{ user: RequestUser; authType: string } | null> {
  // Try session — the prefetch resolved it before the tenant transaction opened.
  //
  // Asking here directly is what produced `permission denied for table session`:
  // by this point the connection runs as `zveltio_rls`, which cannot read Better
  // Auth's tables, and the refusal aborts the transaction rather than merely
  // failing this lookup. `undefined` means the prefetch did not run (a route
  // mounted outside it), so the direct call stays as the fallback.
  const prefetched = c.get('prefetchedSession');
  const session =
    prefetched !== undefined
      ? prefetched
      : await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { user: session.user, authType: 'session' };

  // Try API key
  const rawKey = c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (rawKey?.startsWith('zvk_')) {
    // Defensive: a context without `get` (partial mocks, any future caller
    // that builds one by hand) must not throw here. A hardening check that
    // crashes the authentication path is worse than the gap it closes — it
    // fails every request instead of the wrong ones.
    const requestTenantId =
      typeof c.get === 'function'
        ? ((c.get('tenant') as { id?: string } | null)?.id ?? null)
        : null;
    const apiKey = await validateApiKey(db, rawKey, requestTenantId);
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
export async function validateApiKey(
  db: Database,
  rawKey: string,
  requestTenantId: string | null,
): Promise<ZvApiKeyRow | null> {
  const hash = await hashApiKey(rawKey);
  const apiKey = await db
    .selectFrom('zv_api_keys')
    .selectAll()
    .where('key_hash', '=', hash)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!apiKey) return null;
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) return null;

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
  const keyTenantId = (apiKey as { tenant_id?: string | null }).tenant_id ?? null;
  if (
    keyTenantId &&
    keyTenantId !== DEFAULT_TENANT_ID &&
    requestTenantId &&
    keyTenantId !== requestTenantId
  ) {
    console.warn(
      `[api-key] refused: key ${apiKey.id} belongs to tenant ${keyTenantId} but the ` +
        `request is acting in ${requestTenantId}`,
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

export async function checkAccess(
  db: Database,
  user: RequestUser,
  collection: string,
  action: string,
): Promise<boolean> {
  // Note: never short-circuit on `user.role === 'admin'`. Better-Auth doesn't
  // populate `role` on the session for magic-link / OAuth flows, so we route
  // every check through checkPermission() — it handles god bypass (DB + HMAC
  // cache) first, then Casbin, so admins with proper policies still get
  // access without depending on a session field that may be missing.
  if (user.role === 'api_key') {
    // API keys cannot access system tables
    const tableName = DDLManager.getTableName(collection);
    if (tableName.startsWith('zv_') && !tableName.startsWith('zvd_')) return false;

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
      return matches.some((m) => m.actions.includes(action) || m.actions.includes('*'));
    }
    // No `scopes` value at all (a NULL column) says the same thing an empty list
    // says: nothing was granted.
    console.warn(`[auth] api_key ${user.id} has no scopes at all — refusing access`);
    return false;
  }
  return checkPermission(user.id, collection, action);
}

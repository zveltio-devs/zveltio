/**
 * Authentication + per-collection authorization for the CRUD data path
 * (H-05 split of `routes/data.ts`).
 *
 * `authenticate` resolves a session (better-auth) or API key into a
 * `RequestUser`; `checkAccess` enforces API-key scopes and delegates
 * everything else to `checkPermission` (god bypass + Casbin). Byte-identical
 * to the pre-split inline helpers — zero behaviour change.
 */

import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import type { ZvApiKeyRow } from '../../db/schema.js';
import { DDLManager } from '../ddl-manager.js';
import { checkPermission } from '../permissions.js';
import { hashApiKey } from '../security/index.js';
import type { RequestUser } from './types.js';

/** Authenticate request — session or API key. */
export async function authenticate(
  c: Context,
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in docs/HARDENING-9-PLAN.md H-05
  auth: any,
  db: Database,
): Promise<{ user: RequestUser; authType: string } | null> {
  // Try session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { user: session.user, authType: 'session' };

  // Try API key
  const rawKey = c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (rawKey?.startsWith('zvk_')) {
    const apiKey = await validateApiKey(db, rawKey);
    if (apiKey) {
      return {
        user: {
          id: `apikey:${apiKey.id}`,
          name: apiKey.name,
          role: 'api_key',
          // Pass scopes through so checkAccess() can enforce them per collection/action.
          scopes: apiKey.scopes,
        },
        authType: 'api_key',
      };
    }
  }

  return null;
}

async function validateApiKey(db: Database, rawKey: string): Promise<ZvApiKeyRow | null> {
  const hash = await hashApiKey(rawKey);
  const apiKey = await db
    .selectFrom('zv_api_keys')
    .selectAll()
    .where('key_hash', '=', hash)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!apiKey) return null;
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) return null;

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
    // Empty array = full access (backwards-compatible default).
    // Wildcard collection '*' or action '*' grants broad access.
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
      if (scopes.length > 0) {
        const match = scopes.find((s) => s.collection === collection || s.collection === '*');
        if (!match) return false;
        if (!match.actions.includes(action) && !match.actions.includes('*')) return false;
      }
    }
    return true;
  }
  return checkPermission(user.id, collection, action);
}

/**
 * ADR 0039 decisions 7 and 8: signing in is one engine operation, and an
 * extension declares the ways to sign in it offers.
 *
 * `auth/ldap` and `auth/saml` each wrote the same sequence out of three
 * internals — `provisionUser`, `createBetterAuthSession`, `audit` — and the
 * second took a user id the extension chose, so the holder of `auth:session`
 * could open a session as anyone. Here an extension only says who signed in at
 * its provider; the account, the session and the audit entry are the engine's.
 */

import type { Context } from 'hono';
import { parseCookies } from 'better-auth/cookies';
import type { RouteIdentity, SignInInput } from '@zveltio/sdk/extension';
import { type Database, getDb } from '../../db/index.js';
import { publicRouteRequest } from '../../middleware/extension-auth-gate.js';
import { auditLog } from '../audit.js';
import { getAuth } from '../auth.js';
import { IdentityRefusedError, provisionUser } from '../identity.js';
import { problem } from '../problem.js';
import { clientIpForAudit, SignInBlockedError } from '../security/index.js';
import { withSavepoint } from '../savepoint.js';
import {
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  membershipStanding,
  tenantAdmits,
} from '../tenancy/index.js';
import { createBetterAuthSession } from '../users.js';
import { activeForRequest } from './activation.js';
import { holdsCapability } from './capabilities.js';
import { auditAs } from './tenant-facts.js';

/** A manifest `signInProviders` entry. */
export interface SignInProvider {
  id: string;
  label: string;
  kind: 'credentials' | 'redirect';
  route: string;
}

/** Loaded extension → the providers its manifest declares. */
const providers = new Map<string, readonly SignInProvider[]>();

/** Record an extension's providers on (re)load; an empty list forgets it. */
export function registerSignInProviders(extName: string, list: readonly SignInProvider[]): void {
  if (list.length > 0) providers.set(extName, list);
  else providers.delete(extName);
}

export function unregisterSignInProviders(extName: string): void {
  providers.delete(extName);
}

/**
 * `GET /api/sign-in/providers`: every declared provider of an extension that is
 * on for the request's tenant and may sign in (`auth:session` approved), with
 * the URL that starts it. Public: a sign-in page is drawn before anyone is
 * signed in.
 */
export async function listSignInProviders(c: Context, db: Database) {
  const out: { id: string; label: string; kind: string; extension: string; url: string }[] = [];
  for (const [extension, list] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
    if (!holdsCapability(extension, 'auth:session')) continue;
    if (!(await activeForRequest(c, extension, db))) continue;
    for (const p of list) {
      out.push({
        id: p.id,
        label: p.label,
        kind: p.kind,
        extension,
        url: `/ext/${extension}${p.route}`,
      });
    }
  }
  return out;
}

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null;

/**
 * A declared route's `host.identity`. Each call refuses unless the route is
 * declared `public`, the `/ext/*` gate admitted this request as this
 * extension's public route, the extension holds `auth:session` (else 403
 * `capability_required`), and `provider` is one of its `signInProviders`: the
 * other misuses are the extension's bug, so they throw (500), they do not answer
 * the caller.
 */
export function routeIdentity(c: Context, extName: string, access: string): RouteIdentity {
  const actor = `ext:${extName}`;
  const allowed = (provider: unknown): string => {
    if (access !== 'public' || publicRouteRequest(c)?.extName !== extName) {
      throw new Error(`${extName}: host.identity answers only on a declared public route`);
    }
    // Not the extension's bug: an administrator has not approved it (yet). The
    // provider is not listed then, and a caller who reaches it anyway is told so.
    if (!holdsCapability(extName, 'auth:session')) {
      throw problem(
        'capability_required',
        403,
        `host.identity: "${extName}" does not hold the "auth:session" capability ` +
          '(declared in its manifest and approved by an administrator)',
      );
    }
    if (!providers.get(extName)?.some((p) => p.id === provider)) {
      throw new Error(`${extName}: "${String(provider)}" is not one of its signInProviders`);
    }
    return provider as string;
  };
  const request = () => ({
    ip: clientIpForAudit(c) ?? undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
  });
  // Its own transaction (`auditAs`): the request may roll back, the refusal stays.
  const refused = (provider: string, metadata: Record<string, unknown>, userId?: string) =>
    auditAs(actor, {
      type: 'auth.login_failed',
      resourceType: 'session',
      ...(userId ? { userId } : {}),
      ip: request().ip,
      metadata: { provider, actor, user_agent: request().userAgent, ...metadata },
    });

  return {
    async signIn(input: SignInInput) {
      const provider = allowed(input?.provider);
      const subject = text(input?.subject, 1024);
      if (!subject) throw new Error(`${extName}: signIn needs the person's subject at ${provider}`);
      const { ip, userAgent } = request();
      const trx = getCurrentTenantTrx();
      const tenant = getCurrentDomainOrNull();
      // The `/ext/*` chain always opens both: the tenant that must admit the
      // person, and the transaction that holds the session to its audit entry.
      if (!trx || !tenant) throw new Error(`${extName}: signIn runs only inside a request`);
      let userId: string | undefined;
      try {
        // A session only for a person this tenant admits — the rule every door
        // asks (`tenantAdmits`): a withdrawn member is refused, and an account
        // created here that the tenant would refuse is rolled back with the
        // refusal, not left behind with no membership anywhere.
        const user = await withSavepoint(
          trx,
          'zv_sign_in',
          async () => {
            const { user, created } = await provisionUser(
              {
                email: input.email,
                ...(typeof input.name === 'string' ? { name: input.name } : {}),
              },
              actor,
            );
            const standing = created ? 'none' : await membershipStanding(trx, user.id, tenant);
            if (!tenantAdmits(tenant, standing)) {
              if (!created) userId = user.id;
              throw new IdentityRefusedError(
                'not_a_member',
                'This account is not a member of this tenant.',
              );
            }
            return user;
          },
          (err) => {
            throw err;
          },
        );
        userId = user.id;
        // The user id is the engine's answer above, never the extension's.
        const session = await createBetterAuthSession(trx, getDb(), user.id, {
          ...(ip ? { ipAddress: ip } : {}),
          ...(userAgent ? { userAgent } : {}),
          replaceExisting: true,
        });
        // In the request's transaction: a user it created exists only there, and
        // the row's `user_id` references it.
        await auditLog(trx, {
          type: 'auth.login_success',
          userId: user.id,
          resourceType: 'session',
          ip,
          metadata: { provider, subject, actor, user_agent: userAgent },
        });
        const headers = new Headers({ 'set-cookie': session.setCookie });
        // As the engine's own sign-in (`bearerSessions`): the token only to a
        // caller that did not send the session cookie.
        const cookie = (await getAuth().$context).authCookies.sessionToken.name;
        if (!parseCookies(c.req.header('cookie') ?? '').has(cookie)) {
          headers.set('set-auth-token', session.signed);
          headers.set('access-control-expose-headers', 'set-auth-token');
        }
        return { user: { id: user.id, email: user.email, name: user.name }, headers };
      } catch (err) {
        const code =
          err instanceof SignInBlockedError
            ? 'account_disabled'
            : err instanceof IdentityRefusedError &&
                (err.code === 'account_exists' ||
                  err.code === 'invalid_input' ||
                  err.code === 'not_a_member')
              ? err.code
              : null;
        if (!code) throw err;
        await refused(provider, { subject, reason: code }, userId);
        throw code === 'account_disabled'
          ? problem(code, 403, 'This account is disabled.')
          : code === 'account_exists'
            ? problem(code, 403, 'This provider cannot sign in to that account.')
            : code === 'not_a_member'
              ? problem(code, 403, (err as Error).message)
              : problem(code, 400, (err as Error).message);
      }
    },
    async signInRefused(input) {
      const provider = allowed(input?.provider);
      await refused(provider, {
        identifier: text(input?.identifier, 256),
        reason: text(input?.reason, 500) ?? 'refused',
      });
    },
  };
}

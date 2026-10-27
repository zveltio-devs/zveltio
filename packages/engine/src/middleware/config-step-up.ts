/**
 * Step-up on every configuration mutation (ADR 0006, "Risk"): the Console and
 * the App share an origin, so an XSS in the App against a signed-in
 * administrator can send the configuration API that administrator's cookie. A
 * configuration change therefore also needs the session's step-up window
 * (`requireConfigWindow`, lib/step-up.ts), which only a passkey or TOTP
 * confirmation opens.
 *
 * One classification for the whole configuration API (`config-routes.ts`),
 * checked here, not per handler. Configuration is what the Console does (ADR 0006 §2: schema, roles,
 * permissions, extensions, settings, users, tenants, flows, webhooks, backups,
 * SQL — insights panels and the ad-hoc query included). What a person does in the App is not: their own profile, sessions and
 * factors (`/api/me`, `/api/auth`), data (`/api/data`, `/api/sync`, `/api/rpc/:fn`,
 * `/api/storage`, `/api/revisions`), notifications, saved queries, running an
 * insights panel, and their own ERD layout, which changes only their own view of the diagram.
 *
 * Who passes:
 * - a session with its window open;
 * - nobody signed in and no key: the route's own guard answers (401), so the god
 *   recovery (`/api/permissions/bootstrap`, a recovery token and no session)
 *   stays reachable — and it is exempt by path besides, cookie or not;
 * - an API key never: a key has no session to step up, so it never configures
 *   (403, or 401 for a key that does not authenticate — `refuseWithoutSession`).
 */
import type { MiddlewareHandler } from 'hono';
import { refuseWithoutSession } from '../lib/admin-guard.js';
import { requestApiKey } from '../lib/data/index.js';
import { requireConfigWindow } from '../lib/step-up.js';
import { isConfigMutation } from './config-routes.js';
import { requestSession } from './session-prefetch.js';

export function configStepUp(auth: Parameters<typeof requestSession>[1]): MiddlewareHandler {
  return async (c, next) => {
    if (!isConfigMutation(c.req.method, c.req.path)) return next();
    const session = await requestSession(c, auth);
    if (!session) return requestApiKey(c) ? refuseWithoutSession(c) : next();
    return (await requireConfigWindow(c, session)) ?? next();
  };
}

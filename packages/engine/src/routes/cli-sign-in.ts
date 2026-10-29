/**
 * The CLI's browser confirmation (lib/cli-sign-in.ts, ADR 0011 amendment 1).
 *
 *   POST /api/auth/cli/start    {kind:'login'} | {kind:'step-up', action}  (step-up: the CLI's session)
 *   POST /api/auth/cli/poll     {device_code}                              (no session: the code is the secret)
 *   GET  /api/auth/cli/request?code=                                       (the Console, signed in)
 *   POST /api/auth/cli/approve  {code}  + step-up for `cli.approve:<code>`
 *   POST /api/auth/cli/deny     {code}
 *
 * Mounted with the step-up routes, before the Better Auth catch-all, so the
 * per-IP auth limit covers them; all but /poll, which only the API limit
 * meters (routes/index.ts).
 */
import type { Context, Hono } from 'hono';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { auditLog } from '../lib/audit.js';
import { refuseWithoutSession } from '../lib/admin-guard.js';
import {
  approveCliRequest,
  CLI_POLL_INTERVAL_SECONDS,
  CLI_REQUEST_SECONDS,
  CLI_VERIFICATION_PATH,
  denyCliRequest,
  normalizeUserCode,
  pollCliRequest,
  readCliRequest,
  startCliRequest,
} from '../lib/cli-sign-in.js';
import { clientIpForAudit } from '../lib/security/index.js';
import { isStepUpAction, requireStepUp } from '../lib/step-up.js';
import { requestSession } from '../middleware/session-prefetch.js';

const body = async (c: Context): Promise<Record<string, unknown>> =>
  ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

const badCode = (c: Context) => c.json({ error: 'A code like BCDF-GHJK is required.' }, 400);

export function registerCliSignInRoutes(app: Hono, poolDb: Database): void {
  app.post('/api/auth/cli/start', async (c) => {
    const b = await body(c);
    const common = {
      ip: clientIpForAudit(c),
      userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
    };
    let started: { device_code: string; user_code: string };
    if (b.kind === 'login') {
      started = await startCliRequest({ kind: 'login', ...common });
    } else if (b.kind === 'step-up') {
      if (!isStepUpAction(b.action)) return c.json({ error: 'A valid action is required.' }, 400);
      const session = await requestSession(c, auth);
      if (!session) return refuseWithoutSession(c);
      started = await startCliRequest({
        kind: 'step-up',
        action: b.action,
        sessionId: session.session.id,
        userId: session.user.id,
        ...common,
      });
    } else {
      return c.json({ error: "kind is 'login' or 'step-up'." }, 400);
    }
    return c.json({
      ...started,
      verification_path: CLI_VERIFICATION_PATH,
      expires_in: CLI_REQUEST_SECONDS,
      interval: CLI_POLL_INTERVAL_SECONDS,
    });
  });

  app.post('/api/auth/cli/poll', async (c) => {
    const b = await body(c);
    const outcome = await pollCliRequest(b.device_code as string);
    return c.json(outcome, outcome.status === 'expired' ? 410 : 200);
  });

  app.get('/api/auth/cli/request', async (c) => {
    const session = await requestSession(c, auth);
    if (!session) return refuseWithoutSession(c);
    const code = normalizeUserCode(c.req.query('code'));
    if (!code) return badCode(c);
    const req = await readCliRequest(code);
    if (!req) return c.json({ error: 'This request has expired or was used.' }, 404);
    return c.json({
      code,
      kind: req.kind,
      action: req.action ?? null,
      ip: req.ip,
      user_agent: req.userAgent,
      created_at: req.createdAt,
      // A step-up request is for one account only; the page says so instead of failing late.
      for_this_account: req.kind === 'login' || req.userId === session.user.id,
    });
  });

  app.post('/api/auth/cli/approve', async (c) => {
    const session = await requestSession(c, auth);
    if (!session) return refuseWithoutSession(c);
    const code = normalizeUserCode((await body(c)).code);
    if (!code) return badCode(c);
    const method = await requireStepUp(c, `cli.approve:${code}`);
    if (method instanceof Response) return method;
    const outcome = await approveCliRequest(poolDb, code, { userId: session.user.id }, method);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    auditLog(poolDb, {
      type: 'auth.cli_approved',
      userId: session.user.id,
      resourceType: 'cli_request',
      resourceId: code,
      metadata: { kind: outcome.kind, confirmed_by: method },
      ip: clientIpForAudit(c) ?? undefined,
      tenantId: null,
    }).catch((err: Error) => console.error('[cli-sign-in] audit failed:', err.message));
    return c.json({ approved: true, kind: outcome.kind });
  });

  app.post('/api/auth/cli/deny', async (c) => {
    const session = await requestSession(c, auth);
    if (!session) return refuseWithoutSession(c);
    const code = normalizeUserCode((await body(c)).code);
    if (!code) return badCode(c);
    const req = await readCliRequest(code);
    if (req?.kind === 'step-up' && req.userId !== session.user.id) {
      return c.json({ error: 'This confirmation is for another account.' }, 403);
    }
    return c.json({ denied: await denyCliRequest(code) });
  });
}

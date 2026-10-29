/**
 * The CLI confirms through the browser (ADR 0011, amendment 1): a device flow
 * in the manner of RFC 8628, for what a terminal cannot do itself — sign in, or
 * step up, with a passkey.
 *
 * 1. The CLI starts a request: `login`, or `step-up` for one action on the
 *    session it already holds. It gets a secret `device_code` to poll with and a
 *    short `user_code` to show.
 * 2. The person opens the Console at `/admin/cli-sign-in?code=<user_code>`,
 *    signed in there, compares the code with the terminal, and approves with a
 *    step-up (passkey or TOTP) for `cli.approve:<user_code>`.
 * 3. The CLI's next poll gets the result once: a new session for the approving
 *    user (login), or a step-up token bound to the CLI's own session and the
 *    requested action (step-up).
 *
 * A step-up request is approved only by the user who holds the CLI session.
 * Requests live ten minutes and are taken whole on approve, deny or poll, so
 * each is used at most once. Nothing here outlives one action: every change
 * from the CLI is confirmed on its own, as in the Console.
 *
 * The rows are step-up rows (`verification`, auth pool), ids hashed over the
 * secret, so a database read yields no usable code.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Database } from '../db/index.js';
import { createBetterAuthSession } from './users.js';
import {
  isStepUpAction,
  mintStepUpToken,
  peek,
  put,
  rowId,
  type StepUpMethod,
  take,
} from './step-up.js';

export const CLI_REQUEST_SECONDS = 600;
export const CLI_POLL_INTERVAL_SECONDS = 3;
/** Where the Console shows a request (Studio route `(admin)/cli-sign-in`). */
export const CLI_VERIFICATION_PATH = '/admin/cli-sign-in';

/** Consonants only, as `gh` does: no words, no 0/O or 1/I to misread. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export const normalizeUserCode = (code: unknown): string | null => {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return USER_CODE_RE.test(c) ? c : null;
};

export interface CliRequest {
  kind: 'login' | 'step-up';
  /** step-up only: the action, the CLI session it is for, and that session's user. */
  action?: string;
  sessionId?: string;
  userId?: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  /** SHA-256 of the device code: approve writes the result where that poll looks. */
  device: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const requestRow = (userCode: string) => rowId('cli-req', userCode);
const deviceRow = (deviceHash: string) => rowId('cli-dev', deviceHash);
const resultRow = (deviceHash: string) => rowId('cli-done', deviceHash);

export async function startCliRequest(
  init: Omit<CliRequest, 'createdAt' | 'device'>,
): Promise<{ device_code: string; user_code: string }> {
  if (init.kind === 'step-up' && !(isStepUpAction(init.action) && init.sessionId && init.userId)) {
    throw new Error('A step-up request names an action and the session it is for.');
  }
  const device_code = randomBytes(32).toString('base64url');
  const device = sha(device_code);
  for (;;) {
    const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(20)]).join('');
    const user_code = `${pick()}-${pick()}`;
    const req: CliRequest = { ...init, createdAt: new Date().toISOString(), device };
    // A user code already pending is drawn again rather than shared.
    if (!(await put(requestRow(user_code), 'cli-req', JSON.stringify(req), CLI_REQUEST_SECONDS)))
      continue;
    await put(deviceRow(device), 'cli-dev', user_code, CLI_REQUEST_SECONDS);
    return { device_code, user_code };
  }
}

/** A pending request, for the Console to show before anything is approved. */
export async function readCliRequest(userCode: string): Promise<CliRequest | null> {
  const raw = await peek(requestRow(userCode));
  return raw ? (JSON.parse(raw) as CliRequest) : null;
}

export type ApproveOutcome =
  | { ok: true; kind: CliRequest['kind'] }
  | { ok: false; status: 403 | 410; error: string };

/**
 * Approve `userCode` as `approver`, whose step-up for `cli.approve:<userCode>`
 * the route has already spent (`method`). The request is taken first, so two
 * approvals cannot both act.
 */
export async function approveCliRequest(
  db: Database,
  userCode: string,
  approver: { userId: string },
  method: StepUpMethod,
): Promise<ApproveOutcome> {
  const pending = await readCliRequest(userCode);
  if (!pending) return { ok: false, status: 410, error: 'This request has expired or was used.' };
  if (pending.kind === 'step-up' && pending.userId !== approver.userId) {
    // Checked before the take: someone else opening the link does not cancel it.
    return {
      ok: false,
      status: 403,
      error: 'This confirmation is for another account. Sign in to the Console as that user.',
    };
  }
  const raw = await take(requestRow(userCode));
  if (!raw) return { ok: false, status: 410, error: 'This request has expired or was used.' };
  const req = JSON.parse(raw) as CliRequest;

  let result: string;
  if (req.kind === 'login') {
    // A new session, with the ban check every sign-in runs (the `session.create` hook).
    const s = await createBetterAuthSession(db, db, approver.userId, {
      ...(req.ip ? { ipAddress: req.ip } : {}),
      ...(req.userAgent ? { userAgent: req.userAgent } : {}),
    });
    result = s.signed;
  } else {
    result = await mintStepUpToken(req.sessionId!, req.userId!, req.action!, method);
  }
  await put(resultRow(req.device), 'cli-done', result, CLI_REQUEST_SECONDS);
  return { ok: true, kind: req.kind };
}

/** Refuse a pending request: the CLI's next poll sees it gone. */
export async function denyCliRequest(userCode: string): Promise<boolean> {
  return (await take(requestRow(userCode))) !== null;
}

export type PollOutcome =
  | { status: 'approved'; token: string }
  | { status: 'pending' }
  | { status: 'expired' };

/** What the CLI holding `deviceCode` gets: the result once, else whether to keep waiting. */
export async function pollCliRequest(deviceCode: string): Promise<PollOutcome> {
  if (typeof deviceCode !== 'string' || deviceCode.length < 16) return { status: 'expired' };
  const device = sha(deviceCode);
  const token = await take(resultRow(device));
  if (token) {
    await take(deviceRow(device));
    return { status: 'approved', token };
  }
  const userCode = await peek(deviceRow(device));
  if (userCode && (await peek(requestRow(userCode)))) return { status: 'pending' };
  return { status: 'expired' };
}

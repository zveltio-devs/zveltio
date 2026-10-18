/**
 * Step-up confirmation (engine lib/step-up.ts): before a sensitive change — an
 * extension mutation, adding or removing a sign-in factor — the engine wants a
 * single-use token earned with a passkey, or a code from the account's
 * authenticator app when it has one. `stepUp.token(action)` opens the dialog (`StepUpModal`, mounted once
 * in the admin layout) and resolves with the token once the person confirms.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { api } from './api.js';
import { m } from './i18n.svelte.js';
import { toast } from './stores/toast.svelte.js';

export const STEP_UP_HEADER = 'X-Zveltio-Step-Up';

/** The account has neither a passkey nor TOTP: send the person to enroll one. */
export class StepUpEnrollmentRequired extends Error {
  constructor() {
    super('step_up_enrollment_required');
  }
}

/** The person closed the dialog. Callers treat it as a quiet no-op. */
export class StepUpCancelled extends Error {
  constructor() {
    super('step_up_cancelled');
  }
}

type RequestOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/** What enrolls a first factor (engine `firstFactorRule`). */
export type FirstFactor = 'password' | 'recent_sign_in' | 'sign_in_again';

interface Pending {
  action: string;
  method: 'passkey' | 'totp';
  options?: RequestOptions;
  /** A passkey account that also has an authenticator app: a code is accepted too. */
  totp: boolean;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
}

let pending = $state<Pending | null>(null);

async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await api.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: res.ok,
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** The engine's refusal (problem+json `detail`) in words; ours where the person must act. */
export function refusalText(body: Record<string, unknown>, status: number, totp = false): string {
  switch (body.code) {
    case 'step_up_user_verification_required':
      return totp ? m['stepUp.userVerificationOrCode']() : m['stepUp.userVerificationRequired']();
    case 'password_required':
      return m['passkeys.passwordWrong']();
    case 'recent_sign_in_required':
      return m['passkeys.signInAgain']();
  }
  return String(body.detail ?? body.message ?? body.error ?? `HTTP ${status}`);
}
const refusal = (r: { status: number; body: Record<string, unknown> }, totp = false) =>
  new Error(refusalText(r.body, r.status, totp));

async function options(action: string) {
  const r = await post('/api/auth/step-up/options', { action });
  if (r.body.code === 'step_up_enrollment_required') throw new StepUpEnrollmentRequired();
  if (!r.ok) throw refusal(r);
  return r.body as { method: 'passkey' | 'totp'; options?: RequestOptions; totp?: boolean };
}

export const stepUp = {
  get pending() {
    return pending;
  },

  /** Null when the account has a factor to step up with; else what enrolls its first one. */
  async firstFactor(action: string): Promise<FirstFactor | null> {
    const r = await post('/api/auth/step-up/options', { action });
    if (r.body.code !== 'step_up_enrollment_required') return null;
    return ((r.body.errors as { first_factor?: FirstFactor } | undefined)?.first_factor ??
      'password') as FirstFactor;
  },

  /** A single-use token for `action`. Rejects with StepUpEnrollmentRequired or StepUpCancelled. */
  async token(action: string): Promise<string> {
    const o = await options(action);
    pending?.reject(new StepUpCancelled());
    return new Promise((resolve, reject) => {
      pending = {
        action,
        method: o.method,
        options: o.options,
        totp: o.method === 'totp' || o.totp === true,
        resolve,
        reject,
      };
    });
  },

  /** Send `code`, or run the passkey ceremony; resolves the pending token or throws for the dialog. */
  async confirm(code?: string): Promise<void> {
    const p = pending;
    if (!p) return;
    const payload =
      p.method === 'passkey' && !code
        ? { action: p.action, response: await startAuthentication({ optionsJSON: p.options! }) }
        : { action: p.action, code };
    const r = await post('/api/auth/step-up/verify', payload);
    if (!r.ok) {
      // The engine spent the challenge on the attempt; the next try needs a new one.
      if (p.method === 'passkey') p.options = (await options(p.action)).options;
      throw refusal(r, p.totp);
    }
    pending = null;
    p.resolve(r.body.token as string);
  },

  cancel(): void {
    const p = pending;
    pending = null;
    p?.reject(new StepUpCancelled());
  },
};

/** `{ X-Zveltio-Step-Up: token }` for `action`. */
export async function stepUpHeaders(action: string): Promise<Record<string, string>> {
  return { [STEP_UP_HEADER]: await stepUp.token(action) };
}

/**
 * True when `e` ended a step-up rather than the action: the person cancelled, or
 * has no factor yet — then they are told so and sent to the security settings.
 */
export function stepUpAborted(e: unknown): boolean {
  if (e instanceof StepUpCancelled) return true;
  if (!(e instanceof StepUpEnrollmentRequired)) return false;
  toast.warning(m['stepUp.enrollFirst']());
  void goto(`${base}/account`);
  return true;
}

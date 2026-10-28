/**
 * Step-up confirmation (engine lib/step-up.ts): before a sensitive change — an
 * extension mutation, adding or removing a sign-in factor, issuing an API key —
 * the engine wants a single-use token earned with a passkey, or a code from the
 * account's authenticator app when it has one.
 *
 * `createStepUp` is surface-neutral: the host passes how it reaches the engine
 * and how it words a refusal. `stepUp.token(action)` opens `StepUpDialog`
 * (mounted once in the host's layout) and resolves with the token once the
 * person confirms.
 */
import { startAuthentication } from '@simplewebauthn/browser';

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

export interface StepUpPending {
  action: string;
  method: 'passkey' | 'totp';
  options?: RequestOptions;
  /** A passkey account that also has an authenticator app: a code is accepted too. */
  totp: boolean;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
}

export interface StepUpHost {
  /** Sends a request to the engine with the person's credentials, e.g. `api.fetch`. */
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  /** The engine's refusal in the host's words; `totp` when a code was an option. */
  refusalText: (body: Record<string, unknown>, status: number, totp: boolean) => string;
}

export type StepUp = ReturnType<typeof createStepUp>;

/** The words `StepUpDialog` shows, in the host's language. */
export interface StepUpLabels {
  title: string;
  intro: string;
  codeLabel: string;
  /** For a passkey account that also has an authenticator app. */
  orCodeLabel: string;
  verifyCode: string;
  usePasskey: string;
  cancel: string;
  close: string;
}

export function createStepUp(host: StepUpHost) {
  let pending = $state<StepUpPending | null>(null);

  async function post(path: string, body: unknown) {
    const res = await host.fetch(path, {
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

  const refusal = (r: { status: number; body: Record<string, unknown> }, totp = false) =>
    new Error(host.refusalText(r.body, r.status, totp));

  async function options(action: string) {
    const r = await post('/api/auth/step-up/options', { action });
    if (r.body.code === 'step_up_enrollment_required') throw new StepUpEnrollmentRequired();
    if (!r.ok) throw refusal(r);
    return r.body as { method: 'passkey' | 'totp'; options?: RequestOptions; totp?: boolean };
  }

  /** A single-use token for `action`. Rejects with StepUpEnrollmentRequired or StepUpCancelled. */
  async function token(action: string): Promise<string> {
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
  }

  return {
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

    token,

    /** `{ X-Zveltio-Step-Up: token }` for `action`. */
    async headers(action: string): Promise<Record<string, string>> {
      return { [STEP_UP_HEADER]: await token(action) };
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
      // Another request may have opened the dialog while this one was verifying.
      if (pending === p) pending = null;
      p.resolve(r.body.token as string);
    },

    cancel(): void {
      const p = pending;
      pending = null;
      p?.reject(new StepUpCancelled());
    },
  };
}

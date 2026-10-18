/**
 * Step-up confirmation (engine lib/step-up.ts): before a sensitive change — an
 * extension mutation, adding or removing a sign-in factor — the engine wants a
 * single-use token earned with a passkey, or a TOTP code when the account has no
 * passkey. `stepUp.token(action)` opens the dialog (`StepUpModal`, mounted once
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

interface Pending {
  action: string;
  method: 'passkey' | 'totp';
  options?: RequestOptions;
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

async function options(action: string) {
  const r = await post('/api/auth/step-up/options', { action });
  if (r.body.code === 'step_up_enrollment_required') throw new StepUpEnrollmentRequired();
  if (!r.ok) throw new Error((r.body.error as string) ?? `HTTP ${r.status}`);
  return r.body as { method: 'passkey' | 'totp'; options?: RequestOptions };
}

export const stepUp = {
  get pending() {
    return pending;
  },

  /** Does the account have a factor to step up with? */
  async hasFactor(action: string): Promise<boolean> {
    const r = await post('/api/auth/step-up/options', { action });
    return r.body.code !== 'step_up_enrollment_required';
  },

  /** A single-use token for `action`. Rejects with StepUpEnrollmentRequired or StepUpCancelled. */
  async token(action: string): Promise<string> {
    const o = await options(action);
    pending?.reject(new StepUpCancelled());
    return new Promise((resolve, reject) => {
      pending = { action, method: o.method, options: o.options, resolve, reject };
    });
  },

  /** Run the ceremony (or send `code`); resolves the pending token or throws for the dialog to show. */
  async confirm(code?: string): Promise<void> {
    const p = pending;
    if (!p) return;
    const payload =
      p.method === 'passkey'
        ? { action: p.action, response: await startAuthentication({ optionsJSON: p.options! }) }
        : { action: p.action, code };
    const r = await post('/api/auth/step-up/verify', payload);
    if (!r.ok) {
      // The engine spent the challenge on the attempt; the next try needs a new one.
      if (p.method === 'passkey') p.options = (await options(p.action)).options;
      throw new Error((r.body.error as string) ?? `HTTP ${r.status}`);
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

/**
 * Step-up confirmation for the Studio: the kit's store (`@zveltio/ui/step-up`)
 * reaching the engine through `api` and wording refusals with the Studio's
 * catalogue. `stepUp.token(action)` opens the dialog (`StepUpModal`, mounted
 * once in the admin layout) and resolves with the token once the person confirms.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { createStepUp, StepUpCancelled, StepUpEnrollmentRequired } from '@zveltio/ui/step-up';
import { api } from './api.js';
import { m } from './i18n.svelte.js';
import { toast } from './stores/toast.svelte.js';

export {
  type FirstFactor,
  STEP_UP_HEADER,
  StepUpCancelled,
  StepUpEnrollmentRequired,
} from '@zveltio/ui/step-up';

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

export const stepUp = createStepUp({
  fetch: (path, init) => api.fetch(path, init),
  refusalText,
});

/** `{ X-Zveltio-Step-Up: token }` for `action`. */
export async function stepUpHeaders(action: string): Promise<Record<string, string>> {
  return stepUp.headers(action);
}

/**
 * True when `e` ended a step-up rather than the action: the person cancelled, or
 * has no factor yet — then they are told so and sent to the security settings.
 */
export function stepUpAborted(e: unknown): boolean {
  if (e instanceof StepUpCancelled) return true;
  if (!(e instanceof StepUpEnrollmentRequired)) return false;
  toast.warning(m['stepUp.enrollFirst']());
  void goto(resolve(`account`));
  return true;
}

/**
 * Step-up confirmation for the App: the kit's store (`@zveltio/ui/step-up`)
 * reaching the engine with the session cookie. `StepUpDialog` is mounted once
 * in the workspace layout; the SDK client asks it through `onStepUpRequired`.
 */
import { createStepUp } from '@zveltio/ui/step-up';

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export { StepUpCancelled, StepUpEnrollmentRequired } from '@zveltio/ui/step-up';

export const stepUp = createStepUp({
  fetch: (path, init) => fetch(`${ENGINE_URL}${path}`, { ...init, credentials: 'include' }),
  refusalText: (body, status, totp) =>
    body.code === 'step_up_user_verification_required'
      ? totp
        ? 'This passkey confirmed a touch but not you. Set a PIN or turn on fingerprint or face unlock for your security key, or enter the code from your authenticator app.'
        : 'This passkey confirmed a touch but not you. Set a PIN or turn on fingerprint or face unlock for your security key, then try again.'
      : String(body.detail ?? body.message ?? body.error ?? `HTTP ${status}`),
});

/** The words the dialog shows; the App's account page is English-only so far. */
export const stepUpLabels = {
  title: 'Confirm it is you',
  intro: 'This change needs a fresh confirmation from your passkey or authenticator app.',
  codeLabel: 'Code from your authenticator app',
  orCodeLabel: 'Or a code from your authenticator app',
  verifyCode: 'Verify code',
  usePasskey: 'Use passkey',
  cancel: 'Cancel',
  close: 'Close',
};

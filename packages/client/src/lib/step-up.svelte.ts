/**
 * Step-up confirmation for the App: the kit's store (`@zveltio/ui/step-up`)
 * reaching the engine with the session cookie. `StepUpDialog` is mounted once
 * in the workspace layout; the SDK client asks it through `onStepUpRequired`.
 */
import { createStepUp } from '@zveltio/ui/step-up';
import { i18n, m } from '#lib/i18n.svelte.js';

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export { StepUpCancelled, StepUpEnrollmentRequired } from '@zveltio/ui/step-up';

export const stepUp = createStepUp({
  fetch: (path, init) => fetch(`${ENGINE_URL}${path}`, { ...init, credentials: 'include' }),
  refusalText: (body, status, totp) =>
    body.code === 'step_up_user_verification_required'
      ? totp
        ? m['stepUp.userVerificationOrCode']()
        : m['stepUp.userVerificationRequired']()
      : String(body.detail ?? body.message ?? body.error ?? `HTTP ${status}`),
});

/** A message that re-renders on a locale switch: reading `i18n.locale` is the dependency. */
const t = (key: string): string => {
  void i18n.locale;
  return m[key]();
};

/** The words the dialog shows, as getters so they follow the locale. */
export const stepUpLabels = {
  get title() {
    return t('stepUp.title');
  },
  get intro() {
    return t('stepUp.intro');
  },
  get codeLabel() {
    return t('stepUp.codeLabel');
  },
  get orCodeLabel() {
    return t('stepUp.orCodeLabel');
  },
  get verifyCode() {
    return t('stepUp.verifyCode');
  },
  get usePasskey() {
    return t('stepUp.usePasskey');
  },
  get cancel() {
    return t('common.cancel');
  },
  get close() {
    return t('common.close');
  },
};

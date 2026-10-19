import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Studio half of god step-up: ask the engine what to present, hold the
 * request open until the person confirms in the dialog, and hand back the token
 * the mutation sends as `X-Zveltio-Step-Up`.
 */
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ api: { fetch: apiFetch } }));
const goto = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('./stores/toast.svelte.js', () => ({ toast: { warning: vi.fn() } }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', response: {} })),
}));

import { m } from './i18n.svelte.js';
import {
  refusalText,
  StepUpCancelled,
  stepUp,
  stepUpAborted,
  stepUpHeaders,
} from './step-up.svelte.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bodyOf = (i: number) => JSON.parse(apiFetch.mock.calls[i]![1].body as string);

beforeEach(() => apiFetch.mockReset());

describe('stepUp', () => {
  it('waits for the passkey confirmation and returns the token as the header', async () => {
    apiFetch
      .mockResolvedValueOnce(json({ method: 'passkey', options: { challenge: 'c' } }))
      .mockResolvedValueOnce(json({ token: 'tok-1' }));
    const headers = stepUpHeaders('extension.install:crm');
    await vi.waitFor(() => expect(stepUp.pending?.method).toBe('passkey'));
    await stepUp.confirm();
    expect(await headers).toEqual({ 'X-Zveltio-Step-Up': 'tok-1' });
    expect(apiFetch.mock.calls[1]![0]).toBe('/api/auth/step-up/verify');
    expect(bodyOf(1)).toEqual({
      action: 'extension.install:crm',
      response: { id: 'cred-1', response: {} },
    });
    expect(stepUp.pending).toBeNull();
  });

  it('sends the TOTP code when the account has no passkey, and keeps the dialog on a wrong one', async () => {
    apiFetch
      .mockResolvedValueOnce(json({ method: 'totp' }))
      .mockResolvedValueOnce(json({ error: 'The code is not valid' }, 403))
      .mockResolvedValueOnce(json({ token: 'tok-2' }));
    const token = stepUp.token('extension.enable:crm');
    await vi.waitFor(() => expect(stepUp.pending?.method).toBe('totp'));
    await expect(stepUp.confirm('000000')).rejects.toThrow('The code is not valid');
    expect(stepUp.pending).not.toBeNull();
    await stepUp.confirm('123456');
    expect(await token).toBe('tok-2');
    expect(bodyOf(2)).toEqual({ action: 'extension.enable:crm', code: '123456' });
  });

  it('a confirmation that lands after another request opened the dialog leaves that one open', async () => {
    let verified!: (r: Response) => void;
    apiFetch
      .mockResolvedValueOnce(json({ method: 'totp' }))
      .mockReturnValueOnce(new Promise<Response>((r) => (verified = r)))
      .mockResolvedValueOnce(json({ method: 'totp' }));
    const first = stepUp.token('extension.enable:crm');
    first.catch(() => {});
    await vi.waitFor(() => expect(stepUp.pending?.action).toBe('extension.enable:crm'));
    const confirming = stepUp.confirm('123456');
    const second = stepUp.token('extension.disable:crm');
    second.catch(() => {});
    await vi.waitFor(() => expect(stepUp.pending?.action).toBe('extension.disable:crm'));
    verified(json({ token: 'tok-3' }));
    await confirming;
    await expect(first).rejects.toBeInstanceOf(StepUpCancelled);
    expect(stepUp.pending?.action).toBe('extension.disable:crm');
    stepUp.cancel();
  });

  it("a passkey that did not verify its user says to set a PIN, in the person's language", async () => {
    apiFetch
      .mockResolvedValueOnce(json({ method: 'passkey', options: { challenge: 'c' } }))
      .mockResolvedValueOnce(
        json({ code: 'step_up_user_verification_required', detail: 'engine words' }, 403),
      )
      .mockResolvedValueOnce(json({ method: 'passkey', options: { challenge: 'c2' } }));
    void stepUp.token('extension.install:crm').catch(() => {});
    await vi.waitFor(() => expect(stepUp.pending?.method).toBe('passkey'));
    await expect(stepUp.confirm()).rejects.toThrow(m['stepUp.userVerificationRequired']());
    expect(stepUp.pending).not.toBeNull();
    stepUp.cancel();
  });

  it("shows the engine's problem detail for any other refusal", async () => {
    apiFetch
      .mockResolvedValueOnce(json({ method: 'totp' }))
      .mockResolvedValueOnce(
        json({ code: 'step_up_failed', detail: 'The code is not valid' }, 403),
      );
    void stepUp.token('extension.enable:crm').catch(() => {});
    await vi.waitFor(() => expect(stepUp.pending?.method).toBe('totp'));
    await expect(stepUp.confirm('000000')).rejects.toThrow('The code is not valid');
    stepUp.cancel();
  });

  it('a passkey account with an authenticator app may confirm with a code instead', async () => {
    apiFetch
      .mockResolvedValueOnce(json({ method: 'passkey', options: { challenge: 'c' }, totp: true }))
      .mockResolvedValueOnce(
        json({ code: 'step_up_user_verification_required', detail: 'engine words' }, 403),
      )
      .mockResolvedValueOnce(json({ method: 'passkey', options: { challenge: 'c2' }, totp: true }))
      .mockResolvedValueOnce(json({ token: 'tok-3' }));
    const token = stepUp.token('extension.install:crm');
    await vi.waitFor(() => expect(stepUp.pending?.totp).toBe(true));
    await expect(stepUp.confirm()).rejects.toThrow(m['stepUp.userVerificationOrCode']());
    await stepUp.confirm('123456');
    expect(await token).toBe('tok-3');
    expect(bodyOf(3)).toEqual({ action: 'extension.install:crm', code: '123456' });
  });

  it('tells the passkey section what enrolls a first factor', async () => {
    apiFetch
      .mockResolvedValueOnce(
        json(
          { code: 'step_up_enrollment_required', errors: { first_factor: 'recent_sign_in' } },
          403,
        ),
      )
      .mockResolvedValueOnce(json({ method: 'totp' }));
    expect(await stepUp.firstFactor('factor.passkey.add')).toBe('recent_sign_in');
    expect(await stepUp.firstFactor('factor.passkey.add')).toBeNull();
  });

  it('puts factor refusals in words, not "HTTP 403"', () => {
    expect(refusalText({ code: 'password_required', detail: 'x' }, 403)).toBe(
      m['passkeys.passwordWrong'](),
    );
    expect(refusalText({ code: 'recent_sign_in_required', detail: 'x' }, 403)).toBe(
      m['passkeys.signInAgain'](),
    );
    expect(refusalText({ code: 'forbidden', detail: 'Nope' }, 403)).toBe('Nope');
    expect(refusalText({}, 500)).toBe('HTTP 500');
  });

  it('sends a god with no factor to the security settings', async () => {
    apiFetch.mockResolvedValueOnce(json({ code: 'step_up_enrollment_required' }, 403));
    const err = await stepUp.token('extension.install:crm').catch((e) => e);
    expect(stepUpAborted(err)).toBe(true);
    expect(goto).toHaveBeenCalledWith(expect.stringMatching(/\/account$/));
  });

  it('a closed dialog rejects quietly', async () => {
    apiFetch.mockResolvedValueOnce(json({ method: 'totp' }));
    const token = stepUp.token('extension.install:crm');
    await vi.waitFor(() => expect(stepUp.pending).not.toBeNull());
    stepUp.cancel();
    const err = await token.catch((e) => e);
    expect(err).toBeInstanceOf(StepUpCancelled);
    expect(stepUpAborted(err)).toBe(true);
  });
});

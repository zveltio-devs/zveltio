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

import { StepUpCancelled, stepUp, stepUpAborted, stepUpHeaders } from './step-up.svelte.js';

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

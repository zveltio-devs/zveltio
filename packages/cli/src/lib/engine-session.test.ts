/**
 * The CLI's engine session (ADR 0011) against a fake engine. The flow itself
 * was proven against a live engine; these pin the parts that broke or would
 * break silently: the second sign-in step must not send back the emptied
 * session cookies, the stored file is 0600 and keyed by origin, and an account
 * that steps up with a passkey only is told so instead of asked for a code.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath, engineFetch, saveSession, sessionFor, signIn } from './engine-session.js';

const realFetch = globalThis.fetch;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zv-cli-session-'));
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeEngine(routes: Record<string, (init: RequestInit) => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const route = routes[new URL(String(input)).pathname];
    if (!route) throw new Error(`unexpected ${input}`);
    return route(init);
  }) as typeof fetch;
}

describe('engine session', () => {
  it('completes a 2FA sign-in with the two-factor cookie only', async () => {
    let sentCookie = '';
    fakeEngine({
      '/api/auth/sign-in/email': () => {
        const h = new Headers();
        h.append('set-cookie', 'better-auth.session_token=; Max-Age=0');
        h.append('set-cookie', 'better-auth.two_factor=2fa-abc; Path=/');
        return new Response(JSON.stringify({ twoFactorRedirect: true }), { headers: h });
      },
      '/api/auth/two-factor/verify-totp': (init) => {
        sentCookie = new Headers(init.headers).get('cookie') ?? '';
        return new Response('{}', { headers: { 'set-auth-token': 'tok.sig' } });
      },
    });
    const token = await signIn('https://e.test:3000/x', 'a@b.c', 'pw', async () => '123456');
    expect(token).toBe('tok.sig');
    expect(sentCookie).toBe('better-auth.two_factor=2fa-abc');
  });

  it('keeps one 0600 session per engine origin', () => {
    saveSession('https://e.test:3000/admin', 'one');
    saveSession('https://other.test', 'two');
    expect(sessionFor('https://e.test:3000')).toBe('one');
    expect(sessionFor('https://other.test/')).toBe('two');
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('sends a passkey-only account to the Console instead of asking for a code', async () => {
    saveSession('https://e.test:3000', 'one');
    fakeEngine({
      '/api/auth/step-up/options': () =>
        new Response(JSON.stringify({ method: 'passkey', totp: false })),
    });
    await expect(
      engineFetch(
        { url: 'https://e.test:3000' },
        '/api/marketplace/crm/update',
        {},
        'extension.update:crm',
      ),
    ).rejects.toThrow(/passkey only/);
  });
});

describe('engine session refusals', () => {
  it('refuses a cleartext session to an engine that is not on this machine', () => {
    expect(() => saveSession('http://engine.example.com', 'x')).toThrow(/https/);
    expect(() => saveSession('http://localhost:3000', 'x')).not.toThrow();
  });
});

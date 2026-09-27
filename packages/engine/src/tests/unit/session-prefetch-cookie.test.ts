import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';

/**
 * `/files/*` looks the session up only when the request carries a session
 * cookie. That cookie is named from better-auth's options, and the check read
 * the default `better-auth.` prefix: under a configured `advanced.cookiePrefix`
 * every signed-in caller looked anonymous and shared their address's budget.
 */
function probe(options?: Record<string, unknown>) {
  let lookups = 0;
  const auth = {
    api: {
      getSession: async () => {
        lookups++;
        return null;
      },
    },
    options: options as never,
  };
  const app = new Hono();
  app.use('*', sessionPrefetch(auth, {} as never, { onlyWithCredentials: true }));
  app.get('*', (c) => c.text('ok'));
  return async (cookie: string) => {
    lookups = 0;
    await app.request('/files/x.png', { headers: { cookie } });
    return lookups;
  };
}

describe('sessionPrefetch: which cookie is a session', () => {
  it('reads a configured cookie prefix', async () => {
    const lookups = probe({ baseURL: 'http://localhost', advanced: { cookiePrefix: 'acme' } });
    expect(await lookups('acme.session_token=abc')).toBe(1);
    expect(await lookups('__Secure-acme.session_token=abc')).toBe(1);
    // Under that prefix the default name is just another cookie.
    expect(await lookups('better-auth.session_token=abc')).toBe(0);
    expect(await lookups('theme=dark')).toBe(0);
  });

  it('reads a configured session cookie name', async () => {
    const lookups = probe({
      baseURL: 'http://localhost',
      advanced: { cookies: { session_token: { name: 'sid' } } },
    });
    expect(await lookups('sid=abc')).toBe(1);
    expect(await lookups('better-auth.session_token=abc')).toBe(0);
  });

  it('keeps the default without options', async () => {
    const lookups = probe();
    expect(await lookups('better-auth.session_token=abc')).toBe(1);
    expect(await lookups('better-auth.session_token=')).toBe(0);
  });
});

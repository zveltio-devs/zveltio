/**
 * Cross-site WebSocket hijacking.
 *
 * A session check does not stop it. The same-origin policy does not apply to
 * WebSocket handshakes and browsers attach cookies to them regardless of which
 * page opened the socket, so `new WebSocket('wss://victim-instance/api/ws')`
 * from any page the victim visits produces a fully authenticated connection —
 * the session check passes precisely because the browser sent the real cookie.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { checkWsOrigin } from '../../lib/security/ws-origin.js';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CORS_ORIGINS;
  delete process.env.CORS_ORIGINS;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = saved;
});

describe('the attack', () => {
  it('refuses a socket opened by another site', () => {
    const v = checkWsOrigin('https://evil.example', 'app.zveltio.example');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('evil.example');
  });

  it('refuses even when the attacker origin merely contains the real host', () => {
    // `app.zveltio.example.evil.test` and `evil.test/?app.zveltio.example` both
    // defeat a substring check. The comparison is on the parsed host.
    for (const origin of [
      'https://app.zveltio.example.evil.test',
      'https://evil.test/?app.zveltio.example',
      'https://app.zveltio.example@evil.test',
    ]) {
      expect(checkWsOrigin(origin, 'app.zveltio.example').allowed).toBe(false);
    }
  });

  it('refuses a malformed Origin rather than trying to interpret it', () => {
    expect(checkWsOrigin('not-a-url', 'app.example').allowed).toBe(false);
  });
});

describe('the real app still connects', () => {
  it('allows same-origin when no allowlist is configured', () => {
    const v = checkWsOrigin('https://app.zveltio.example', 'app.zveltio.example');
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('same-origin');
  });

  it('allows same-origin on localhost and a LAN IP, without configuration', () => {
    // The self-hosted case: the engine is reached as localhost by one operator
    // and as a LAN address by another. Comparing Origin to Host covers both
    // with no list to maintain.
    expect(checkWsOrigin('http://localhost:3000', 'localhost:3000').allowed).toBe(true);
    expect(checkWsOrigin('http://192.168.1.40:3000', '192.168.1.40:3000').allowed).toBe(true);
  });

  it('is case-insensitive and ignores a trailing slash', () => {
    expect(checkWsOrigin('https://APP.Example/', 'app.example').allowed).toBe(true);
  });

  it('treats a different port as a different origin', () => {
    expect(checkWsOrigin('http://localhost:5173', 'localhost:3000').allowed).toBe(false);
  });
});

describe('CORS_ORIGINS as the explicit allowlist', () => {
  it('allows a listed origin served from a different host', () => {
    // A separate front-end deployment is the case the allowlist exists for.
    process.env.CORS_ORIGINS = 'https://studio.example, https://app.example';
    expect(checkWsOrigin('https://studio.example', 'api.example').allowed).toBe(true);
  });

  it('still allows same-origin when the list names only other origins', () => {
    // This used to assert the opposite — "an explicit allowlist replaces the
    // same-origin fallback rather than widening it: an operator who wrote a list
    // meant that list". Coherent, and wrong about the one origin that is not a
    // third party: the Studio is served BY this engine, so its origin is
    // whatever the operator reached the engine on.
    //
    // Measured on a clean install: `CORS_ORIGINS` was set for a separate
    // frontend, and every Studio WebSocket upgrade was refused with
    // `origin http://127.0.0.1:3300 is not in CORS_ORIGINS` — realtime dead on
    // the admin UI, with the reason only in the server log. The operator wrote
    // that list to admit their frontend, not to evict their own admin panel.
    process.env.CORS_ORIGINS = 'https://studio.example';
    expect(checkWsOrigin('https://api.example', 'api.example').allowed).toBe(true);
  });

  it('still refuses a cross-origin caller that is not on the list', () => {
    // The guard the allowlist exists for is untouched: a page on another origin
    // opening a socket with the victim's cookie is refused whether or not a list
    // is configured. That is the whole attack.
    process.env.CORS_ORIGINS = 'https://studio.example';
    expect(checkWsOrigin('https://evil.example', 'api.example').allowed).toBe(false);
  });

  it('honours a wildcard when an operator sets one', () => {
    process.env.CORS_ORIGINS = '*';
    expect(checkWsOrigin('https://anything.example', 'api.example').allowed).toBe(true);
  });

  it('falls back to same-origin when the variable is empty or blank', () => {
    process.env.CORS_ORIGINS = '  ,  ';
    expect(checkWsOrigin('https://api.example', 'api.example').allowed).toBe(true);
    expect(checkWsOrigin('https://evil.example', 'api.example').allowed).toBe(false);
  });
});

describe('non-browser clients', () => {
  it('allows a request with no Origin header', () => {
    // The CLI, server-to-server consumers and tests send no Origin, and they
    // are not the threat: the attack works because a BROWSER attaches
    // credentials automatically. A client already holding the cookie gains
    // nothing by omitting a header.
    expect(checkWsOrigin(undefined, 'api.example').allowed).toBe(true);
    expect(checkWsOrigin(null, 'api.example').allowed).toBe(true);
  });

  it('still allows a missing Origin when an allowlist is configured', () => {
    process.env.CORS_ORIGINS = 'https://studio.example';
    expect(checkWsOrigin(undefined, 'api.example').allowed).toBe(true);
  });

  it('refuses when an Origin is present but there is no Host to compare', () => {
    expect(checkWsOrigin('https://evil.example', undefined).allowed).toBe(false);
  });
});

/**
 * The subprocess runner's SSRF blocklist is the validator's, not a copy of it.
 *
 * The bootstrap runs as a standalone `.mjs` and cannot import
 * `security/url-validator.ts`, so the guard has to exist inside that string. It
 * used to be a hand-written copy under a "keep in sync" comment, and it did not
 * stay in sync. Two patterns were added to the real blocklist and never reached
 * the copy:
 *
 *   192.0.0.192      Oracle Cloud's instance metadata — globally routable, so
 *                    no "is this private" test catches it
 *   100.64.0.0/10    RFC 6598 shared space — managed Kubernetes pod networks,
 *                    Tailscale, internal fabrics
 *
 * Measured before the repair: `assertPublicUrl` refused both, while an edge
 * function running in the subprocess fetched both — the request went out and
 * hung until the execution timeout instead of being refused.
 *
 * Both halves matter here. The behavioural cases below are what actually
 * failed; the last test is the one that keeps it from happening again, because
 * a pattern added to the validator tomorrow has to appear in the bootstrap
 * without anyone remembering a second place.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  runEdgeFunctionInSubprocess,
  __subprocessBootstrapForTests,
} from '../../lib/edge-functions/subprocess-runner.js';
import {
  BLOCKED_PATTERNS,
  buildSandboxSafeFetchSource,
  buildSandboxSsrfGuardSource,
} from '../../lib/security/url-validator.js';
import { __workerBootstrapForTests } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

async function fetchFromSandbox(target: string) {
  const code = `async function handler() {
    try {
      const res = await fetch(${JSON.stringify(target)});
      return { status: 200, body: 'FETCHED ' + res.status };
    } catch (e) {
      return { status: 200, body: 'threw: ' + e.message };
    }
  }`;
  const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 4000);
  return String(res.response?.body ?? res.error ?? '');
}

describe('runEdgeFunctionInSubprocess — blocklist parity with url-validator', () => {
  it("blocks Oracle Cloud's metadata address, which reads as ordinary public space", async () => {
    expect(await fetchFromSandbox('http://192.0.0.192/opc/v1/instance/')).toContain('blocked');
  });

  it('blocks RFC 6598 shared address space', async () => {
    expect(await fetchFromSandbox('http://100.64.0.1/')).toContain('blocked');
  });

  it('carries every pattern the validator blocks, so the two cannot drift again', () => {
    for (const pattern of BLOCKED_PATTERNS) {
      expect(__subprocessBootstrapForTests, pattern.toString()).toContain(pattern.toString());
    }
  });
});

/**
 * The DNS half of the generated guard, driven with a stub resolver.
 *
 * The behavioural cases above are literal IPs, because that is what a test may
 * assume. The case that matters most cannot be: an attacker-owned NAME with an A
 * record pointing at 169.254.169.254 is precisely what the literal blocklist
 * cannot see, and asserting it end to end would mean depending on somebody
 * else's DNS zone staying put.
 *
 * So the generator is driven directly. `buildSandboxSsrfGuardSource` emits the
 * `_assertUrl` both bootstraps use; evaluating that source with a stub lookup
 * proves the resolved addresses are checked, deterministically and offline.
 *
 * (Measured once against a real resolver, for confidence that the stub is not
 * describing a different world: `http://localtest.me:5432/` — a public name whose
 * record is ::1 — is refused by both runners with "resolves to ::1", while
 * `isBlockedHost('localtest.me')` on its own is false.)
 */
function buildAssertUrl(guardSource: string, lookup: unknown) {
  const factory = new Function(
    '_stubLookup',
    `${guardSource.replace(/\b_dnsLookupImpl\b/g, '_stubLookup')}\nreturn _assertUrl;`,
  );
  return factory(lookup) as (url: string) => Promise<void>;
}

describe('the generated SSRF guard checks what a hostname resolves to', () => {
  const resolvesToMetadata = async () => [{ address: '169.254.169.254' }];

  it('refuses a public name whose address is private', async () => {
    const assertUrl = buildAssertUrl(
      buildSandboxSsrfGuardSource('_dnsLookupImpl'),
      resolvesToMetadata,
    );
    await expect(assertUrl('http://harmless.example.com/')).rejects.toThrow(/resolves to 169\.254/);
  });

  it('lets a public name through when its addresses are public', async () => {
    const assertUrl = buildAssertUrl(buildSandboxSsrfGuardSource('_dnsLookupImpl'), async () => [
      { address: '93.184.216.34' },
    ]);
    await assertUrl('https://example.com/');
  });

  it('allows an unresolvable name, because fetch cannot reach it either', async () => {
    const assertUrl = buildAssertUrl(buildSandboxSsrfGuardSource('_dnsLookupImpl'), async () => {
      throw new Error('ENOTFOUND');
    });
    await assertUrl('https://nothing.invalid/');
  });

  it('gives the worker bootstrap the resolver variant, not the literal-only one', () => {
    expect(__workerBootstrapForTests).toContain("from 'node:dns/promises'");
    expect(__workerBootstrapForTests).toContain('resolves to ');
  });
});

/**
 * The connection goes to the address that was checked.
 *
 * Validating a NAME and then handing the name to fetch leaves the rebinding
 * race open: two resolutions, and only the first one was inspected. This was
 * recorded as unclosable because "fetch offers no way to pin the connection" —
 * which is not true here. The generated safeFetch requests the validated IP and
 * carries the original authority in a Host header, plus a TLS serverName so the
 * certificate is still verified against the name.
 *
 * Driven with a stub `_fetch`, so what is asserted is the URL the sandbox would
 * actually open — not that some request succeeded.
 */
function buildSafeFetch(lookup: unknown, recorder: (url: string, init: any) => void) {
  const source = `
    ${buildSandboxSsrfGuardSource('_stubLookup')}
    ${buildSandboxSafeFetchSource()}
    return safeFetch;
  `.replace(/\b_dnsLookupImpl\b/g, '_stubLookup');

  const factory = new Function('_stubLookup', '_fetch', source);
  return factory(lookup, async (url: string, init: any) => {
    recorder(url, init);
    return new Response('ok', { status: 200 });
  }) as (url: string, init?: unknown) => Promise<Response>;
}

describe('the sandbox connects to the address it validated', () => {
  it('requests the IP, and carries the name in Host and TLS serverName', async () => {
    const seen: { url: string; init: any }[] = [];
    const safeFetch = buildSafeFetch(
      async () => [{ address: '93.184.216.34' }],
      (url, init) => seen.push({ url, init }),
    );

    await safeFetch('https://example.com/some/path?q=1');

    expect(seen).toHaveLength(1);
    // The name is gone from the URL — that is the whole point: a second
    // resolution cannot happen, so it cannot answer differently.
    expect(seen[0].url).toBe('https://93.184.216.34/some/path?q=1');
    expect(new Headers(seen[0].init.headers).get('host')).toBe('example.com');
    expect(seen[0].init.tls).toEqual({ serverName: 'example.com' });
  });

  it('keeps the port in the Host header, because a vhost is chosen by authority', async () => {
    const seen: { url: string; init: any }[] = [];
    const safeFetch = buildSafeFetch(
      async () => [{ address: '93.184.216.34' }],
      (url, init) => seen.push({ url, init }),
    );

    await safeFetch('http://example.com:8080/');

    expect(seen[0].url).toBe('http://93.184.216.34:8080/');
    expect(new Headers(seen[0].init.headers).get('host')).toBe('example.com:8080');
    // Plain HTTP has no certificate to check, so no serverName is set.
    expect(seen[0].init.tls).toBeUndefined();
  });

  it('leaves an IP literal alone — there was never a name to re-resolve', async () => {
    const seen: { url: string; init: any }[] = [];
    const safeFetch = buildSafeFetch(
      async () => {
        throw new Error('the resolver must not be consulted for a literal');
      },
      (url, init) => seen.push({ url, init }),
    );

    await safeFetch('http://93.184.216.34/');

    expect(seen[0].url).toBe('http://93.184.216.34/');
    expect(new Headers(seen[0].init.headers ?? {}).get('host')).toBeNull();
  });
});

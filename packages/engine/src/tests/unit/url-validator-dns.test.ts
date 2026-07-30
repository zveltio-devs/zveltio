/**
 * assertPublicUrl — the DNS-aware half of the SSRF guard.
 *
 * The literal blocklist only ever saw the TEXT of a host, so a name the
 * attacker controls (A record → 169.254.169.254) walked straight through.
 * These tests pin the resolved-address check that closes that.
 *
 * DNS is mocked at the `node:dns/promises` boundary so the suite stays
 * hermetic — no resolver, no network, deterministic in CI.
 *
 * NOTE: the stub is driven by a mutable `nextAnswer` reset in beforeEach,
 * NOT by mockImplementationOnce. Two of these cases assert that DNS is never
 * consulted at all, so a queued once-implementation would survive the test and
 * leak into whatever file bun runs next in the same process — the documented
 * mock.module cross-file leak. A single stable implementation cannot leak.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { mock } from 'bun:test';

type Answer = { address: string; family: number }[];

const PUBLIC_ANSWER: Answer = [{ address: '93.184.216.34', family: 4 }];

let nextAnswer: Answer = PUBLIC_ANSWER;
let shouldThrow = false;
let lookupCalls = 0;

const lookupStub = async (_host: string, _opts?: unknown): Promise<Answer> => {
  lookupCalls++;
  if (shouldThrow) throw new Error('ENOTFOUND');
  return nextAnswer;
};

mock.module('node:dns/promises', () => ({
  lookup: lookupStub,
  default: { lookup: lookupStub },
}));

const { assertPublicUrl } = await import('../../lib/security/url-validator.js');

beforeEach(() => {
  nextAnswer = PUBLIC_ANSWER;
  shouldThrow = false;
  lookupCalls = 0;
});

describe('assertPublicUrl — resolved-address blocking', () => {
  it('rejects a public hostname that resolves to cloud metadata', async () => {
    nextAnswer = [{ address: '169.254.169.254', family: 4 }];

    await expect(assertPublicUrl('https://totally-legit.example.com/')).rejects.toThrow(
      /resolves to 169\.254\.169\.254/,
    );
  });

  it('rejects a hostname that resolves to loopback', async () => {
    nextAnswer = [{ address: '127.0.0.1', family: 4 }];

    await expect(assertPublicUrl('https://rebind.example.com/')).rejects.toThrow(
      /internal\/private address blocked/,
    );
  });

  it('rejects a hostname that resolves to an RFC1918 address', async () => {
    nextAnswer = [{ address: '10.1.2.3', family: 4 }];

    await expect(assertPublicUrl('https://intranet.example.com/')).rejects.toThrow(
      /resolves to 10\.1\.2\.3/,
    );
  });

  it('rejects when only ONE of several answers is private (round-robin poisoning)', async () => {
    nextAnswer = [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ];

    await expect(assertPublicUrl('https://multi.example.com/')).rejects.toThrow(
      /resolves to 192\.168\.1\.1/,
    );
  });

  it('rejects a hostname that resolves to IPv6 loopback', async () => {
    nextAnswer = [{ address: '::1', family: 6 }];

    await expect(assertPublicUrl('https://v6.example.com/')).rejects.toThrow(
      /internal\/private address blocked/,
    );
  });

  it('allows a hostname that resolves to a public address', async () => {
    await expect(assertPublicUrl('https://example.com/')).resolves.toBeUndefined();
    expect(lookupCalls).toBe(1);
  });

  it('still rejects literal private IPs without consulting DNS', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /internal\/private address blocked/,
    );
    expect(lookupCalls).toBe(0);
  });

  it('skips the DNS round-trip for public IP literals', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/')).resolves.toBeUndefined();
    expect(lookupCalls).toBe(0);
  });

  it('allows an unresolvable host — fetch cannot reach it either', async () => {
    shouldThrow = true;

    await expect(assertPublicUrl('https://does-not-exist.example/')).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes before any resolution happens', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/Only http\/https/);
    expect(lookupCalls).toBe(0);
  });
});

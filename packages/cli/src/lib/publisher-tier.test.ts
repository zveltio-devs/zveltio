import { describe, it, expect, afterEach } from 'bun:test';
import { resolvePublisherTier, tierAllowsInline } from './publisher-tier.js';

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: any, init?: any) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

describe('tierAllowsInline', () => {
  it('first-party and verified allow inline; community does not', () => {
    expect(tierAllowsInline('first-party')).toBe(true);
    expect(tierAllowsInline('verified')).toBe(true);
    expect(tierAllowsInline('community')).toBe(false);
  });
});

describe('resolvePublisherTier', () => {
  it('--first-party short-circuits to first-party without a network call', async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const r = await resolvePublisherTier({ firstParty: true, token: 'zvt_x' });
    expect(r).toEqual({ tier: 'first-party', allowsInline: true, source: 'flag' });
    expect(called).toBe(false);
  });

  it('defaults to community when no token is available (offline)', async () => {
    delete process.env.ZVELTIO_REGISTRY_TOKEN;
    const r = await resolvePublisherTier({});
    expect(r).toEqual({ tier: 'community', allowsInline: false, source: 'default' });
  });

  it('reads the tier from the registry when a token is present', async () => {
    mockFetch((url, init) => {
      expect(url).toContain('/api/dev/publisher/self');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer zvt_abc');
      return new Response(JSON.stringify({ tier: 'verified' }), { status: 200 });
    });
    const r = await resolvePublisherTier({ token: 'zvt_abc' });
    expect(r).toEqual({ tier: 'verified', allowsInline: true, source: 'registry' });
  });

  it('passes keyId through as a query param when provided', async () => {
    mockFetch((url) => {
      expect(url).toContain('keyId=key-1');
      return new Response(JSON.stringify({ tier: 'first-party' }), { status: 200 });
    });
    const r = await resolvePublisherTier({ token: 'zvt_abc', keyId: 'key-1' });
    expect(r.tier).toBe('first-party');
    expect(r.source).toBe('registry');
  });

  it('degrades to community when the registry returns non-200', async () => {
    mockFetch(() => new Response('nope', { status: 401 }));
    const r = await resolvePublisherTier({ token: 'zvt_bad' });
    expect(r).toEqual({ tier: 'community', allowsInline: false, source: 'default' });
  });

  it('degrades to community on a network error (never throws)', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const r = await resolvePublisherTier({ token: 'zvt_x' });
    expect(r).toEqual({ tier: 'community', allowsInline: false, source: 'default' });
  });

  it('ignores an unknown tier value from the registry', async () => {
    mockFetch(() => new Response(JSON.stringify({ tier: 'platinum' }), { status: 200 }));
    const r = await resolvePublisherTier({ token: 'zvt_x' });
    expect(r.tier).toBe('community');
    expect(r.source).toBe('default');
  });

  it('uses ZVELTIO_REGISTRY_TOKEN from the environment', async () => {
    process.env.ZVELTIO_REGISTRY_TOKEN = 'zvt_env';
    mockFetch((_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer zvt_env');
      return new Response(JSON.stringify({ tier: 'verified' }), { status: 200 });
    });
    const r = await resolvePublisherTier({});
    expect(r.tier).toBe('verified');
  });
});

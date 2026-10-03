/**
 * S3 storage driver (lib/storage/s3-driver.ts) — the offline-testable surface:
 * config detection + URL construction + presigned-URL signing (aws4fetch signs
 * locally, no network). put/get/delete need a live endpoint and are covered by
 * the best-effort S3 harness lane.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { probeS3 } from '../../lib/storage/probe.js';
import { S3Driver } from '../../lib/storage/s3-driver.js';

const SNAP = { ...process.env };
const realFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...SNAP };
  globalThis.fetch = realFetch;
});

describe('S3Driver (offline surface)', () => {
  it('isConfigured tracks S3_ENDPOINT', () => {
    const d = new S3Driver();
    process.env.S3_ENDPOINT = '';
    expect(d.isConfigured()).toBe(false);
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    expect(d.isConfigured()).toBe(true);
    expect(d.kind).toBe('s3');
  });

  it('publicUrl uses S3_PUBLIC_URL verbatim when set (bucket already included)', () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    process.env.S3_PUBLIC_URL = 'https://cdn.example.com/zveltio';
    expect(new S3Driver().publicUrl('public/uploads/a.png')).toBe(
      'https://cdn.example.com/zveltio/public/uploads/a.png',
    );
  });

  it('publicUrl falls back to endpoint + bucket when S3_PUBLIC_URL is unset', () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    delete process.env.S3_PUBLIC_URL;
    process.env.S3_BUCKET = 'files';
    expect(new S3Driver().publicUrl('public/uploads/a.png')).toBe(
      'http://seaweedfs:8333/files/public/uploads/a.png',
    );
  });

  it('signedUrl produces an aws4-presigned GET with an expiry (offline signing)', async () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    process.env.S3_ACCESS_KEY = 'ak';
    process.env.S3_SECRET_KEY = 'sk';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_BUCKET = 'zveltio';
    const url = await new S3Driver().signedUrl('uploads/a.png', 3600);
    const u = new URL(url);
    expect(u.pathname).toBe('/zveltio/uploads/a.png');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(u.searchParams.get('X-Amz-Credential')).toContain('ak');
  });

  // Private by default, same model as the local driver: only keys under an
  // explicit public namespace (public/, media/) get a bare URL. A bare URL for
  // a private key is exactly what stripping X-Amz-* off a presigned link yields.
  it('publicUrl refuses a private key — signedUrl is the only way to it', () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    process.env.S3_PUBLIC_URL = 'https://cdn.example.com/zveltio';
    const d = new S3Driver();
    expect(() => d.publicUrl('uploads/2026/contract.pdf')).toThrow(/not in a public namespace/);
    expect(() => d.publicUrl('backups/db.dump')).toThrow(/not in a public namespace/);
    expect(d.publicUrl('media/logo.png')).toBe('https://cdn.example.com/zveltio/media/logo.png');
  });

  it('a legacy flat key stays readable: the stored key is addressed verbatim', async () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    process.env.S3_BUCKET = 'zveltio';
    const seen: string[] = [];
    globalThis.fetch = (async (req: Request) => {
      seen.push(new URL(req.url).pathname);
      return new Response('old bytes', { headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    const obj = await new S3Driver().get('uploads/2025/legacy.txt');
    expect(new TextDecoder().decode(obj?.bytes)).toBe('old bytes');
    expect(seen).toEqual(['/zveltio/uploads/2025/legacy.txt']);
  });
});

describe('probeS3 — private objects must not be anonymously readable', () => {
  /** Fake S3: signed requests behave; an UNSIGNED GET answers `anonStatus`. */
  function fakeS3(anonStatus: number): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const signed = req.headers.has('authorization');
      calls.push(`${req.method} ${signed ? 'signed' : 'anon'}`);
      if (!signed)
        return new Response(anonStatus === 200 ? 'zveltio-probe' : '', { status: anonStatus });
      if (req.method === 'GET') return new Response('zveltio-probe');
      return new Response(null, { status: req.method === 'DELETE' ? 204 : 200 });
    }) as typeof fetch;
    return calls;
  }
  const s3 = {
    endpoint: 'http://seaweedfs:8333',
    accessKey: 'ak',
    secretKey: 'sk',
    region: 'us-east-1',
    bucket: 'zveltio',
    publicUrl: '',
  };

  it('fails when the bucket serves a private key to an anonymous GET', async () => {
    const calls = fakeS3(200);
    const r = await probeS3(s3);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/anonymous/i);
    expect(calls).toContain('DELETE signed'); // the probe object is still cleaned up
  });

  it('passes when the anonymous GET is refused', async () => {
    const calls = fakeS3(403);
    const r = await probeS3(s3);
    expect(r.ok).toBe(true);
    expect(calls).toContain('GET anon');
  });
});

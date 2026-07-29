/**
 * S3 storage driver (lib/storage/s3-driver.ts) — the offline-testable surface:
 * config detection + URL construction + presigned-URL signing (aws4fetch signs
 * locally, no network). put/get/delete need a live endpoint and are covered by
 * the best-effort S3 harness lane.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { S3Driver } from '../../lib/storage/s3-driver.js';

const SNAP = { ...process.env };
afterEach(() => {
  process.env = { ...SNAP };
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
    expect(new S3Driver().publicUrl('uploads/a.png')).toBe(
      'https://cdn.example.com/zveltio/uploads/a.png',
    );
  });

  it('publicUrl falls back to endpoint + bucket when S3_PUBLIC_URL is unset', () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    delete process.env.S3_PUBLIC_URL;
    process.env.S3_BUCKET = 'files';
    expect(new S3Driver().publicUrl('uploads/a.png')).toBe(
      'http://seaweedfs:8333/files/uploads/a.png',
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
});

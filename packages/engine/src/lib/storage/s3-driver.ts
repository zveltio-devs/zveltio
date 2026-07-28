/**
 * S3 storage driver — the existing aws4fetch path, unchanged in behaviour and
 * consolidated out of routes/storage.ts + routes/media.ts (both had their own
 * copy of `getAws()` / `s3Url()`). aws4fetch is a ~3KB fetch signer vs ~50MB for
 * the AWS SDK v3.
 */

import { AwsClient } from 'aws4fetch';
import type { PutOptions, StorageDriver, StorageObject } from './driver.js';

export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;
  private _aws: AwsClient | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.S3_ENDPOINT);
  }

  private client(): AwsClient {
    if (!this._aws) {
      this._aws = new AwsClient({
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
        region: process.env.S3_REGION || 'us-east-1',
        service: 's3',
      });
    }
    return this._aws;
  }

  private url(key: string): string {
    const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/$/, '');
    const bucket = process.env.S3_BUCKET || 'zveltio';
    return `${endpoint}/${bucket}/${key}`;
  }

  async put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<void> {
    const res = await this.client().fetch(this.url(key), {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: {
        'Content-Type': opts?.contentType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
    });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
  }

  async get(key: string): Promise<StorageObject | null> {
    const res = await this.client().fetch(this.url(key), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      size: bytes.length,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client()
      .fetch(this.url(key), { method: 'DELETE' })
      .catch(() => {
        /* non-fatal if already gone */
      });
  }

  publicUrl(key: string): string {
    const base = (process.env.S3_PUBLIC_URL || process.env.S3_ENDPOINT || '').replace(/\/$/, '');
    // S3_PUBLIC_URL may already include the bucket; S3_ENDPOINT does not.
    if (process.env.S3_PUBLIC_URL) return `${base}/${key}`;
    return `${base}/${process.env.S3_BUCKET || 'zveltio'}/${key}`;
  }

  async signedUrl(key: string, expiresInSec: number): Promise<string> {
    const target = new URL(this.url(key));
    target.searchParams.set('X-Amz-Expires', String(expiresInSec));
    const signed = await this.client().sign(target, {
      method: 'GET',
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

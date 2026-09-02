/**
 * S3 storage driver — the existing aws4fetch path, unchanged in behaviour and
 * consolidated out of routes/storage.ts + routes/media.ts (both had their own
 * copy of `getAws()` / `s3Url()`). aws4fetch is a ~3KB fetch signer vs ~50MB for
 * the AWS SDK v3.
 */

import { AwsClient } from 'aws4fetch';
import { storageConfig } from './config.js';
import type { PutOptions, StorageDriver, StorageObject } from './driver.js';

export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;

  isConfigured(): boolean {
    return Boolean(storageConfig().s3.endpoint);
  }

  // Built per-call from the resolved config (cheap) so a settings change is
  // picked up without recreating the driver.
  private client(): AwsClient {
    const { accessKey, secretKey, region } = storageConfig().s3;
    return new AwsClient({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: region || 'us-east-1',
      service: 's3',
    });
  }

  private url(key: string): string {
    const { endpoint, bucket } = storageConfig().s3;
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`;
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
    const { endpoint, bucket, publicUrl } = storageConfig().s3;
    // publicUrl may already include the bucket; endpoint does not.
    if (publicUrl) return `${publicUrl.replace(/\/$/, '')}/${key}`;
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`;
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

  /** Same signing as `signedUrl`, for a PUT. See the interface for why. */
  async signedPutUrl(key: string, expiresInSec: number): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const target = new URL(this.url(key));
    target.searchParams.set('X-Amz-Expires', String(expiresInSec));
    const signed = await this.client().sign(target, {
      method: 'PUT',
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

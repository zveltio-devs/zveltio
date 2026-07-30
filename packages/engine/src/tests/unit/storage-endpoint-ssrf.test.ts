/**
 * validateStorageEndpoint — SSRF guard for the admin "Test connection" probe.
 * Blocks cloud-metadata / link-local hosts (IMDS credential theft) while still
 * allowing the private ranges a self-hosted SeaweedFS/MinIO legitimately uses.
 */

import { describe, expect, it } from 'bun:test';
import { validateStorageEndpoint } from '../../lib/security/index.js';

describe('validateStorageEndpoint', () => {
  it('blocks the cloud-metadata IP (169.254.169.254)', () => {
    expect(() => validateStorageEndpoint('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  it('blocks obfuscated metadata IP forms (decimal / hex)', () => {
    expect(() => validateStorageEndpoint('http://2852039166/')).toThrow(); // 169.254.169.254
    expect(() => validateStorageEndpoint('http://0xA9FEA9FE/')).toThrow();
  });

  it('blocks GCP/Azure metadata hostnames and IPv6 link-local', () => {
    expect(() => validateStorageEndpoint('http://metadata.google.internal/')).toThrow();
    expect(() => validateStorageEndpoint('http://[fe80::1]/')).toThrow();
    expect(() => validateStorageEndpoint('http://[fd00:ec2::254]/')).toThrow();
  });

  it('blocks non-http(s) schemes', () => {
    expect(() => validateStorageEndpoint('file:///etc/passwd')).toThrow();
  });

  it('ALLOWS legitimate self-hosted S3 endpoints (private ranges)', () => {
    for (const ok of [
      'http://seaweedfs:8333',
      'http://127.0.0.1:8333',
      'http://10.0.0.5:9000',
      'http://192.168.1.10:9000',
      'https://s3.amazonaws.com',
      'https://minio.example.com',
    ]) {
      expect(() => validateStorageEndpoint(ok)).not.toThrow();
    }
  });
});

/**
 * `ctx.config` — the configuration an extension may read.
 *
 * Two properties are worth pinning, and both come from real defects:
 *
 *  1. Object storage is capability-gated, because it carries S3 credentials.
 *  2. Values are LIVE. Storage settings have an admin-editable overlay on top
 *     of the environment, and the extensions reading `S3_*` directly missed it
 *     entirely — they saw an unconfigured instance and silently skipped object
 *     storage while an administrator watched uploads "succeed".
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildExtensionConfig } from '../../lib/extensions/config.js';
import { setStorageOverlay } from '../../lib/storage/index.js';

const ENV_KEYS = [
  'NODE_ENV',
  'PUBLIC_URL',
  'FIELD_ENCRYPTION_KEY',
  'CROSS_DOMAIN_AUTH',
  'ALLOW_INSECURE_LDAP',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'S3_REGION',
  'STORAGE_DRIVER',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  setStorageOverlay({});
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setStorageOverlay({});
});

describe('object storage is capability-gated', () => {
  beforeEach(() => {
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_ACCESS_KEY = 'AKIA_TEST';
    process.env.S3_SECRET_KEY = 'shhh';
  });

  it('is undefined without the storage capability', () => {
    expect(buildExtensionConfig([]).objectStorage).toBeUndefined();
  });

  it('never leaks credentials to an extension that did not ask', () => {
    const serialised = JSON.stringify(buildExtensionConfig(['db:admin', 'secrets']));
    expect(serialised).not.toContain('shhh');
    expect(serialised).not.toContain('AKIA_TEST');
  });

  it('is present with the storage capability', () => {
    const s = buildExtensionConfig(['storage']).objectStorage;
    expect(s?.accessKeyId).toBe('AKIA_TEST');
    expect(s?.secretAccessKey).toBe('shhh');
    expect(s?.bucket).toBe('zveltio');
    expect(s?.region).toBe('us-east-1');
  });

  it('strips a trailing slash so endpoint + bucket + key stays well-formed', () => {
    process.env.S3_ENDPOINT = 'https://s3.example.com/';
    expect(buildExtensionConfig(['storage']).objectStorage?.endpoint).toBe(
      'https://s3.example.com',
    );
  });

  it('is undefined when the instance has no object storage', () => {
    delete process.env.S3_ENDPOINT;
    expect(buildExtensionConfig(['storage']).objectStorage).toBeUndefined();
  });
});

describe('config is live, not a boot-time snapshot', () => {
  it('sees the admin overlay an extension reading S3_* would have missed', () => {
    const config = buildExtensionConfig(['storage']);
    expect(config.objectStorage).toBeUndefined();

    // The administrator configures object storage from the Studio. This writes
    // the overlay, not the environment — which is exactly why reading
    // `process.env.S3_ENDPOINT` reported "not configured" forever.
    setStorageOverlay({
      driver: 's3',
      s3: {
        endpoint: 'https://minio.internal',
        accessKey: 'from-studio',
        secretKey: 'studio-secret',
        region: 'eu-central-1',
        bucket: 'files',
        publicUrl: 'https://cdn.example.com',
      },
    });

    expect(config.objectStorage?.endpoint).toBe('https://minio.internal');
    expect(config.objectStorage?.accessKeyId).toBe('from-studio');
    expect(config.objectStorage?.publicUrl).toBe('https://cdn.example.com');
  });

  it('reflects an environment change without rebuilding the config', () => {
    const config = buildExtensionConfig([]);
    expect(config.isProduction).toBe(false);
    process.env.NODE_ENV = 'production';
    expect(config.isProduction).toBe(true);
  });
});

describe('scalar configuration', () => {
  it('normalises env to the three known values', () => {
    expect(buildExtensionConfig([]).env).toBe('development');
    process.env.NODE_ENV = 'test';
    expect(buildExtensionConfig([]).env).toBe('test');
    process.env.NODE_ENV = 'staging';
    expect(buildExtensionConfig([]).env).toBe('development');
  });

  it('exposes encryption as a boolean, never the key', () => {
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    const config = buildExtensionConfig(['secrets']);
    expect(config.encryptionConfigured).toBe(true);
    expect(JSON.stringify(config)).not.toContain('aaaa');
  });

  it('treats an unset flag as false and accepts 1 or true', () => {
    expect(buildExtensionConfig([]).crossDomainAuth).toBe(false);
    process.env.CROSS_DOMAIN_AUTH = 'true';
    expect(buildExtensionConfig([]).crossDomainAuth).toBe(true);
    process.env.CROSS_DOMAIN_AUTH = '1';
    expect(buildExtensionConfig([]).crossDomainAuth).toBe(true);
    process.env.CROSS_DOMAIN_AUTH = 'no';
    expect(buildExtensionConfig([]).crossDomainAuth).toBe(false);
  });

  it('leaves publicUrl undefined rather than empty when unset', () => {
    expect(buildExtensionConfig([]).publicUrl).toBeUndefined();
    process.env.PUBLIC_URL = '  https://app.example.com  ';
    expect(buildExtensionConfig([]).publicUrl).toBe('https://app.example.com');
  });
});

/**
 * Storage config resolution (lib/storage/config.ts) — env base + DB overlay,
 * driver auto-selection, overlay-wins semantics.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { setStorageOverlay, storageConfig } from '../../lib/storage/config.js';

const SNAP = { ...process.env };
afterEach(() => {
  process.env = { ...SNAP };
  setStorageOverlay({}); // clear the DB overlay
});

describe('storageConfig', () => {
  it('defaults to the local driver with no env/overlay', () => {
    for (const k of ['STORAGE_DRIVER', 'S3_ENDPOINT', 'STORAGE_LOCAL_DIR']) delete process.env[k];
    const c = storageConfig();
    expect(c.driver).toBe('local');
    // Install-relative default (writable without root), not an absolute /var/lib.
    expect(c.localDir).toBe(`${process.cwd()}/storage`);
  });

  it('auto-selects s3 when S3_ENDPOINT is set', () => {
    delete process.env.STORAGE_DRIVER;
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    expect(storageConfig().driver).toBe('s3');
  });

  it('explicit STORAGE_DRIVER=local wins over a set S3_ENDPOINT', () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    expect(storageConfig().driver).toBe('local');
  });

  it('the DB overlay wins over env and drives selection', () => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.S3_ENDPOINT;
    setStorageOverlay({ driver: 's3', s3: { endpoint: 'http://mine:8333', bucket: 'b' } });
    const c = storageConfig();
    expect(c.driver).toBe('s3');
    expect(c.s3.endpoint).toBe('http://mine:8333');
    expect(c.s3.bucket).toBe('b');
  });

  it('overlay leaves unset fields to fall back to env', () => {
    process.env.S3_ACCESS_KEY = 'env-ak';
    setStorageOverlay({ driver: 's3', s3: { endpoint: 'http://mine:8333' } });
    const c = storageConfig();
    expect(c.s3.endpoint).toBe('http://mine:8333'); // from overlay
    expect(c.s3.accessKey).toBe('env-ak'); // from env fallback
  });
});

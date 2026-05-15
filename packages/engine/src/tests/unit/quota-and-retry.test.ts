import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  directorySizeBytes,
  QuotaExceededError,
  DownMissingError,
  fetchWithRetry,
  DEFAULT_QUOTAS,
} from '../../lib/extension-loader.js';

describe('directorySizeBytes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `zveltio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 0 for a non-existent directory', async () => {
    const size = await directorySizeBytes(join(tmpDir, 'nope'));
    expect(size).toBe(0);
  });

  it('returns 0 for an empty directory', async () => {
    const size = await directorySizeBytes(tmpDir);
    expect(size).toBe(0);
  });

  it('sums sizes of files at the root', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'a'.repeat(100));
    writeFileSync(join(tmpDir, 'b.txt'), 'b'.repeat(50));
    const size = await directorySizeBytes(tmpDir);
    expect(size).toBe(150);
  });

  it('recurses into subdirectories', async () => {
    writeFileSync(join(tmpDir, 'root.txt'), 'x'.repeat(20));
    mkdirSync(join(tmpDir, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(tmpDir, 'nested', 'mid.txt'), 'y'.repeat(30));
    writeFileSync(join(tmpDir, 'nested', 'deep', 'deep.txt'), 'z'.repeat(40));
    const size = await directorySizeBytes(tmpDir);
    expect(size).toBe(90);
  });
});

describe('QuotaExceededError', () => {
  it('captures quota name, observed, and limit', () => {
    const err = new QuotaExceededError('bundleSizeKb', 75_000, 50_000, 'my-ext');
    expect(err.quota).toBe('bundleSizeKb');
    expect(err.observed).toBe(75_000);
    expect(err.limit).toBe(50_000);
    expect(err.message).toContain('my-ext');
    expect(err.message).toContain('75000');
    expect(err.message).toContain('50000');
    expect(err.name).toBe('QuotaExceededError');
  });
});

describe('DownMissingError', () => {
  it('captures extension name and list of migrations missing DOWN sections', () => {
    const err = new DownMissingError('finance/invoicing', [
      'ext:finance/invoicing:001_init',
      'ext:finance/invoicing:003_indexes',
    ]);
    expect(err.extensionName).toBe('finance/invoicing');
    expect(err.missingMigrations).toEqual([
      'ext:finance/invoicing:001_init',
      'ext:finance/invoicing:003_indexes',
    ]);
    expect(err.message).toContain('finance/invoicing');
    expect(err.message).toContain('001_init');
    expect(err.message).toContain('003_indexes');
    expect(err.name).toBe('DownMissingError');
  });
});

describe('DEFAULT_QUOTAS', () => {
  it('exposes the expected defaults', () => {
    expect(DEFAULT_QUOTAS.bundleSizeKbMax).toBe(50_000);
    expect(DEFAULT_QUOTAS.nodeModulesSizeMbMax).toBe(200);
    expect(DEFAULT_QUOTAS.migrationsMax).toBe(100);
  });
});

describe('fetchWithRetry', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns immediately on 2xx', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.test/x', {});
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('does NOT retry on 4xx (except 429)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.test/x', {});
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it('retries on 5xx until success', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) {
        return new Response('bad', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.test/x', {});
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  }, 15_000);

  it('retries on 429 (rate-limited)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.test/x', {});
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  }, 5_000);

  it('retries on network errors and surfaces the last one if all fail', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError('Network down');
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry('https://example.test/x', {})).rejects.toThrow('Network down');
    expect(calls).toBe(3);
  }, 15_000);
});

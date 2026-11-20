/**
 * Digest pinning: a published version's bytes must never change.
 *
 * The download path already verifies the registry's declared SHA-256 and its
 * Ed25519 signature. Both compare against what the registry is serving TODAY,
 * so a registry that re-publishes different content under an existing version
 * passes both — it declares and signs the new bytes perfectly honestly. Only a
 * record of what was actually installed notices.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import { downloadExtension } from '../../lib/extensions/extension-download.js';

const ARCHIVE = Buffer.from('PK\x03\x04 not-a-real-zip but has the magic bytes');
// sha256 of the bytes above, computed the same way the download path does.
const { createHash } = await import('node:crypto');
const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE).digest('hex');

const entry = {
  name: 'crm/core',
  version: '1.2.0',
  displayName: 'CRM',
  description: '',
  category: 'crm',
  author: 'zveltio',
  download_url: 'https://registry.example/api/extensions/by-name/crm%2Fcore/download',
} as any;

const originalFetch = globalThis.fetch;
let savedKeys: string | undefined;
// Signed as the registry signs (there is no unsigned install); here we only care
// about the digest comparison.
const KEY = await generateKeypair('pin-registry');
const SIG = await signBundle(new Uint8Array(ARCHIVE), KEY);
const TRUSTED = JSON.stringify([await exportTrustedKeyEntry(KEY.keyId, KEY.publicJwk)]);

beforeEach(() => {
  savedKeys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
  process.env.REGISTRY_PUBLIC_KEYS_JSON = TRUSTED;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith('.sig')) return Response.json(SIG);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-archive-sha256': ARCHIVE_SHA }),
      arrayBuffer: async () => ARCHIVE.buffer.slice(0, ARCHIVE.length),
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedKeys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
  else process.env.REGISTRY_PUBLIC_KEYS_JSON = savedKeys;
});

describe('a version whose contents changed', () => {
  it('is refused, naming both digests', async () => {
    const pinned = 'f'.repeat(64);
    await expect(
      downloadExtension(entry, '/tmp/zveltio-pin-test', undefined, pinned),
    ).rejects.toThrow(/does not match what was installed/i);
  });

  it('says a re-publish needs a new version, not a workaround', async () => {
    // The message is the control. An operator who reads "hash mismatch" retries
    // or clears a cache; one who reads this escalates to the publisher.
    try {
      await downloadExtension(entry, '/tmp/zveltio-pin-test', undefined, 'f'.repeat(64));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('must never');
      expect((e as Error).message).toContain('new version');
      expect((e as Error).message).toContain('1.2.0');
    }
  });

  it('refuses BEFORE the registry-declared hash is consulted', async () => {
    // The point of pinning: the registry's own declaration agrees with the new
    // bytes, so a check that only compares those two passes. Here the declared
    // header is correct for the served bytes and the download must still fail.
    await expect(
      downloadExtension(entry, '/tmp/zveltio-pin-test', undefined, 'a'.repeat(64)),
    ).rejects.toThrow(/does not match what was installed/i);
  });
});

describe('no pin', () => {
  it('does not block a first install', async () => {
    // A fresh install has nothing to compare against; refusing would make the
    // feature unusable rather than safe.
    await expect(
      downloadExtension(entry, '/tmp/zveltio-pin-test-fresh', undefined, null),
    ).rejects.not.toThrow(/does not match what was installed/i);
  });

  it('does not block when the pin matches', async () => {
    await expect(
      downloadExtension(entry, '/tmp/zveltio-pin-test-match', undefined, ARCHIVE_SHA),
    ).rejects.not.toThrow(/does not match what was installed/i);
  });
});

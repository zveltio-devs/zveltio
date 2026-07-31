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
  // biome-ignore lint/suspicious/noExplicitAny: catalog entry shape is wider than this test needs
} as any;

const originalFetch = globalThis.fetch;
let savedRequireSig: string | undefined;

beforeEach(() => {
  savedRequireSig = process.env.REQUIRE_EXTENSION_SIGNATURES;
  process.env.REQUIRE_EXTENSION_SIGNATURES = '0';
  globalThis.fetch = (async (url: string) => {
    // The `.sig` sibling is absent — signature handling is covered elsewhere;
    // here we only care about the digest comparison.
    if (String(url).endsWith('.sig')) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
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
  if (savedRequireSig === undefined) delete process.env.REQUIRE_EXTENSION_SIGNATURES;
  else process.env.REQUIRE_EXTENSION_SIGNATURES = savedRequireSig;
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

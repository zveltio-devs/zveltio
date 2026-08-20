/**
 * Oracle Cloud's instance metadata service lives at 192.0.0.192.
 *
 * Every other IMDS this guard knows about is link-local — 169.254.169.254 on
 * AWS, GCP and Azure — and the blocklist reasons in ranges, so one pattern
 * covers all three. Oracle's is not link-local and not private: 192.0.0.0/24 is
 * a globally-routable IANA special-purpose block, so it reads as an ordinary
 * public address to a check that asks "is this internal?".
 *
 * That is the whole point of this file. The address hands out cloud credentials
 * exactly like 169.254.169.254 does, and the reasoning that stops one does not
 * stop the other, so it has to be named. A regression here would not look like a
 * bug — it would look like a public URL being allowed, which is the guard
 * working.
 */

import { describe, expect, it } from 'bun:test';
import { isBlockedHost, validatePublicUrl } from '../../lib/security/url-validator.js';
import { validateStorageEndpoint } from '../../lib/security/index.js';

describe('SSRF guard — Oracle Cloud IMDS (192.0.0.192)', () => {
  it('blocks it on the general public-URL guard', () => {
    expect(isBlockedHost('192.0.0.192')).toBe(true);
    expect(() => validatePublicUrl('http://192.0.0.192/opc/v2/instance/')).toThrow();
  });

  it('blocks it on the storage-endpoint guard, which deliberately allows private ranges', () => {
    // This guard permits localhost and 10/8 so a self-hosted MinIO works, which
    // is precisely why IMDS has to be excluded by name rather than by "is it
    // private".
    expect(() => validateStorageEndpoint('http://192.0.0.192')).toThrow();
  });

  it('blocks Oracle’s metadata hostname too', () => {
    expect(isBlockedHost('metadata.oraclecloud.com')).toBe(false);
    expect(() => validateStorageEndpoint('https://metadata.oraclecloud.com')).toThrow();
  });

  it('leaves the rest of 192.0.0.0/24 and ordinary public addresses alone', () => {
    // The fix is one address, not a range: blocking 192.0.0.0/24 wholesale would
    // be over-broad, and blocking 192.0.x.y would break real hosts.
    expect(isBlockedHost('192.0.0.191')).toBe(false);
    expect(isBlockedHost('192.0.1.192')).toBe(false);
    expect(() => validatePublicUrl('https://example.com')).not.toThrow();
  });

  it('still blocks the link-local IMDS it always did', () => {
    // A control: if this ever fails the guard is broken generally, and the
    // assertions above would be passing for the wrong reason.
    expect(isBlockedHost('169.254.169.254')).toBe(true);
  });
});

/**
 * url-validator.ts — normalizeHost encoding tricks + validatePublicUrl.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeHost, validatePublicUrl } from '../../lib/security/url-validator.js';

describe('normalizeHost', () => {
  it('converts single hex integers to dotted IPv4', () => {
    expect(normalizeHost('0x7f000001')).toBe('127.0.0.1');
  });

  it('converts large decimal integers to dotted IPv4', () => {
    expect(normalizeHost('2130706433')).toBe('127.0.0.1');
  });

  it('normalizes per-octet hex and octal dotted forms', () => {
    expect(normalizeHost('0x7f.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('0177.0.0.1')).toBe('127.0.0.1');
  });
});

describe('validatePublicUrl — encoded loopback bypasses', () => {
  it('blocks decimal-encoded loopback hosts', () => {
    expect(() => validatePublicUrl('http://2130706433/')).toThrow(/internal\/private/);
  });

  it('blocks hex-encoded loopback hosts', () => {
    expect(() => validatePublicUrl('http://0x7f000001/')).toThrow(/internal\/private/);
  });

  it('blocks octal-dotted loopback hosts', () => {
    expect(() => validatePublicUrl('http://0177.0.0.1/')).toThrow(/internal\/private/);
  });
});

/**
 * Adaptive rate-limit helpers (TECHNICAL-GAPS 2.5).
 *
 * These sit on the hottest path in the engine, so the pure parts are pinned
 * here: the escalation curve (must never overflow or exceed the cap) and the
 * CIDR matcher (a wrong match would either block a legitimate client or let a
 * denied one through — both bad, in opposite directions).
 */

import { describe, expect, it } from 'bun:test';
import {
  escalationSeconds,
  ipMatches,
  normalizeIp,
  parseCidrList,
} from '../../middleware/rate-limit.js';

describe('normalizeIp', () => {
  it('unwraps the IPv4-mapped IPv6 form Bun reports for IPv4 peers', () => {
    // Without this, every IPv4 client looks like an IPv6 address: the CIDR
    // lists never match and per-IP bucketing keys off a weird string.
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::FFFF:10.1.2.3')).toBe('10.1.2.3');
  });

  it('passes through plain v4/v6 and rejects nothing', () => {
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('is undefined for empty input', () => {
    expect(normalizeIp(undefined)).toBeUndefined();
    expect(normalizeIp('')).toBeUndefined();
    expect(normalizeIp(null)).toBeUndefined();
  });
});

describe('escalationSeconds', () => {
  it('a first offence costs exactly one window', () => {
    expect(escalationSeconds(1, 60)).toBe(60);
  });

  it('doubles per repeat offence', () => {
    expect(escalationSeconds(2, 60)).toBe(120);
    expect(escalationSeconds(3, 60)).toBe(240);
    expect(escalationSeconds(4, 60)).toBe(480);
  });

  it('caps so an identifier can never be locked out indefinitely', () => {
    expect(escalationSeconds(50, 60)).toBe(3600);
    // The exponent is clamped before it can overflow into Infinity/NaN.
    expect(Number.isFinite(escalationSeconds(1e9, 60))).toBe(true);
    expect(escalationSeconds(1e9, 60)).toBe(3600);
  });

  it('treats junk offence counts as a first offence', () => {
    expect(escalationSeconds(0, 60)).toBe(60);
    expect(escalationSeconds(-5, 60)).toBe(60);
  });
});

describe('parseCidrList', () => {
  it('is empty for undefined/blank', () => {
    expect(parseCidrList(undefined)).toHaveLength(0);
    expect(parseCidrList('')).toHaveLength(0);
    expect(parseCidrList('  ,  ')).toHaveLength(0);
  });

  it('accepts bare IPs (implicit /32) and CIDRs, trimming whitespace', () => {
    expect(parseCidrList('10.0.0.1, 192.168.0.0/16')).toHaveLength(2);
  });

  it('drops malformed entries rather than throwing', () => {
    // A bad list must not take the whole middleware down on boot.
    expect(parseCidrList('999.1.1.1, 10.0.0.0/33, nonsense, 1.2.3, 10.0.0.0/8')).toHaveLength(1);
  });
});

describe('ipMatches', () => {
  const list = parseCidrList('10.0.0.0/8, 192.168.1.5, 172.16.0.0/12');

  it('matches inside a CIDR', () => {
    expect(ipMatches('10.1.2.3', list)).toBe(true);
    expect(ipMatches('172.16.5.5', list)).toBe(true);
  });

  it('matches a bare IP exactly', () => {
    expect(ipMatches('192.168.1.5', list)).toBe(true);
    expect(ipMatches('192.168.1.6', list)).toBe(false);
  });

  it('does not match outside', () => {
    expect(ipMatches('11.0.0.1', list)).toBe(false);
    expect(ipMatches('172.32.0.1', list)).toBe(false); // just past the /12
  });

  it('never matches on an empty list', () => {
    expect(ipMatches('10.0.0.1', [])).toBe(false);
  });

  it('returns false (not a crash) for IPv6 and unresolved IPs', () => {
    expect(ipMatches('::1', list)).toBe(false);
    expect(ipMatches('unknown', list)).toBe(false);
    expect(ipMatches('', list)).toBe(false);
  });

  it('handles the /0 and /32 mask edges', () => {
    expect(ipMatches('8.8.8.8', parseCidrList('0.0.0.0/0'))).toBe(true);
    expect(ipMatches('8.8.8.8', parseCidrList('8.8.8.8/32'))).toBe(true);
    expect(ipMatches('8.8.8.9', parseCidrList('8.8.8.8/32'))).toBe(false);
  });

  it('handles high octets without sign-bit surprises', () => {
    // 240.0.0.0 sets the top bit — a signed shift here would mis-compare.
    expect(ipMatches('240.1.2.3', parseCidrList('240.0.0.0/8'))).toBe(true);
    expect(ipMatches('239.1.2.3', parseCidrList('240.0.0.0/8'))).toBe(false);
  });
});

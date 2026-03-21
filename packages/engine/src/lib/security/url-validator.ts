/**
 * url-validator.ts — Single source of truth for SSRF-safe URL validation.
 *
 * Consolidates logic previously duplicated across:
 *   - safe-fetch.ts          (prefix string matching + partial normalization)
 *   - worker-runner.ts       (prefix string matching only)
 *   - virtual-collection-adapter.ts (regex blocklist + IPv4-mapped IPv6)
 *
 * Improvements over individual implementations:
 *   - Handles alternative IP representations: hex, octal-dotted, decimal-int, IPv4-mapped IPv6
 *   - Per-octet hex/octal normalization (e.g. 0x7f.0x0.0x0.0x1 → 127.0.0.1)
 *   - Single regex blocklist (no string-prefix vs regex inconsistency)
 */

function intToIPv4(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8)  & 0xff,
    n          & 0xff,
  ].join('.');
}

/**
 * Normalize alternative IPv4/IPv6 representations to dotted-decimal so the
 * blocklist cannot be bypassed via encoding tricks.
 *
 * Covers:
 *   0x7f000001          → 127.0.0.1  (single hex integer)
 *   2130706433          → 127.0.0.1  (single decimal integer)
 *   0177.0.0.1          → 127.0.0.1  (octal-dotted)
 *   0x7f.0x0.0x0.0x1   → 127.0.0.1  (per-octet hex)
 *   ::ffff:127.0.0.1    → 127.0.0.1  (IPv4-mapped IPv6, dotted form)
 *   ::ffff:7f00:0001    → 127.0.0.1  (IPv4-mapped IPv6, hex-word form)
 */
export function normalizeHost(host: string): string {
  const h = host.toLowerCase();

  // IPv4-mapped IPv6 dotted: ::ffff:127.0.0.1
  let m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];

  // IPv4-mapped IPv6 hex words: ::ffff:7f00:0001
  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  // Single hex integer: 0x7f000001
  if (/^0x[0-9a-f]+$/.test(h)) {
    return intToIPv4(parseInt(h, 16));
  }

  // Single decimal integer > 65535: 2130706433
  if (/^\d+$/.test(h)) {
    const n = parseInt(h, 10);
    if (n > 0xffff && n <= 0xffffffff) return intToIPv4(n);
  }

  // Dotted notation with mixed octal/hex per-octet: 0177.0.0.1 or 0x7f.0.0.1
  if (/^[\da-fx.]+$/.test(h) && h.includes('.')) {
    const octets = h.split('.');
    if (octets.length === 4) {
      const nums = octets.map((o) => {
        if (o.startsWith('0x')) return parseInt(o, 16);
        if (o.startsWith('0') && o.length > 1) return parseInt(o, 8);
        return parseInt(o, 10);
      });
      if (nums.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
        return nums.join('.');
      }
    }
  }

  return h;
}

const BLOCKED_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\.\d+\.\d+\.\d+$/,                  // 127.0.0.0/8
  /^10\.\d+\.\d+\.\d+$/,                    // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,   // 172.16.0.0/12
  /^192\.168\.\d+\.\d+$/,                   // 192.168.0.0/16
  /^169\.254\.\d+\.\d+$/,                   // 169.254.0.0/16 (link-local / cloud metadata)
  /^::1$/,                                   // IPv6 loopback
  /^fd[0-9a-f]{2}:/,                        // IPv6 ULA (fc00::/7)
  /^0\.0\.0\.0$/,
  /host\.docker\.internal$/,
  /kubernetes\.default$/,
];

function isBlockedHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return BLOCKED_PATTERNS.some((re) => re.test(host) || re.test(normalized));
}

/**
 * Validate that a URL is safe to fetch — rejects non-http(s) schemes and
 * URLs that resolve to private/internal network addresses.
 *
 * Throws an Error if the URL is invalid or blocked.
 */
export function validatePublicUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are allowed (got "${parsed.protocol}")`);
  }

  if (isBlockedHost(parsed.hostname.toLowerCase())) {
    throw new Error(`Network access to internal/private address blocked: ${rawUrl}`);
  }
}

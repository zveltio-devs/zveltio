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
 *   - DNS-aware variant (assertPublicUrl) so a *hostname* pointing at private
 *     space cannot walk past the literal-IP blocklist
 */

import { lookup } from 'node:dns/promises';

function intToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
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
  /^127\.\d+\.\d+\.\d+$/, // 127.0.0.0/8
  /^10\.\d+\.\d+\.\d+$/, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // 172.16.0.0/12
  /^192\.168\.\d+\.\d+$/, // 192.168.0.0/16
  /^169\.254\.\d+\.\d+$/, // 169.254.0.0/16 (link-local / cloud metadata)
  /^::1$/, // IPv6 loopback
  /^::$/, // IPv6 unspecified (equivalent to 0.0.0.0)
  /^fe[89ab][0-9a-f]:/, // IPv6 link-local fe80::/10
  /^f[cd][0-9a-f]{2}:/, // IPv6 ULA fc00::/7 (fc.. and fd..)
  /^0\.0\.0\.0$/,
  /host\.docker\.internal$/,
  /kubernetes\.default$/,
];

export function isBlockedHost(host: string): boolean {
  // `URL.hostname` wraps IPv6 in brackets ("[::1]"); strip them so the IPv6
  // patterns (and IPv4-mapped normalization) actually match — otherwise
  // http://[::1] / http://[::ffff:127.0.0.1] slip past the SSRF guard.
  const bare = host.replace(/^\[|\]$/g, '');
  const normalized = normalizeHost(bare);
  return BLOCKED_PATTERNS.some((re) => re.test(bare) || re.test(normalized));
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

/**
 * Whether `host` is already an IP literal in some encoding. Such hosts were
 * checked exhaustively by the blocklist above, so they need no DNS round-trip.
 */
function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true; // any IPv6 form
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalizeHost(host));
}

/**
 * DNS-aware SSRF guard. Everything {@link validatePublicUrl} enforces, plus:
 * the hostname is resolved and EVERY returned address is run through the same
 * blocklist.
 *
 * Without this step the guard only ever inspected the literal text of the host,
 * so `http://internal.attacker.com` — an attacker-controlled name with an A
 * record pointing at 169.254.169.254 — passed untouched and the request reached
 * cloud instance metadata. Anywhere a user or tenant admin supplies a URL
 * (webhook targets, flow HTTP nodes, edge-function fetch, virtual collection
 * sources) that is a reachable path, so the check belongs in the shared
 * validator rather than at each call site.
 *
 * Resolution failure is deliberately NOT fatal: a host that does not resolve
 * cannot be reached by the subsequent fetch either, so there is nothing left to
 * protect against, and failing closed would break offline/CI runs and hosts
 * behind a transient resolver blip.
 *
 * Residual risk: a DNS rebinding race (resolve → public, connect → private) is
 * not closed here, because fetch() offers no way to pin the connection to the
 * address we validated. Closing it needs a custom dispatcher/agent — tracked as
 * defence-in-depth, not a bypass of this check.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  validatePublicUrl(rawUrl);

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return;
  }

  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new Error(
        `Network access to internal/private address blocked: ${rawUrl} resolves to ${address}`,
      );
    }
  }
}

// Cloud instance-metadata + link-local endpoints. These are NEVER a legitimate
// object-storage endpoint, but ARE the highest-value SSRF target (IMDS hands out
// cloud credentials). Blocked for storage endpoints — while ordinary private
// ranges (localhost, 10/8, 192.168/16) stay allowed, since a self-hosted
// SeaweedFS/MinIO legitimately lives there.
const METADATA_PATTERNS: RegExp[] = [
  /^169\.254\.\d+\.\d+$/, // IPv4 link-local (AWS/GCP/Azure IMDS 169.254.169.254)
  /^fe[89ab][0-9a-f]:/, // IPv6 link-local
  /^fd00:ec2:/, // AWS IMDSv6 (fd00:ec2::254)
  /(^|\.)metadata\.google\.internal$/,
  /(^|\.)metadata\.azure\.com$/,
];

/**
 * SSRF guard for an admin-supplied endpoint that is ALLOWED to be self-hosted.
 *
 * The middle ground between "any URL" and {@link validatePublicUrl}: private
 * ranges stay permitted, because the whole point of these endpoints is that they
 * run on your own network — object storage (SeaweedFS/MinIO on 10.x), a local
 * Ollama on `http://localhost:11434`, an internal Meilisearch. Applying the full
 * public-URL guard to them would break the documented self-hosted setup.
 *
 * What is NOT negotiable is cloud metadata: 169.254.169.254 and friends hand out
 * instance credentials, and are never a legitimate endpoint for any of these
 * services. `label` is used in the error message so the operator learns which
 * setting was rejected. Throws on a blocked host.
 */
export function assertNonMetadataUrl(rawUrl: string, label = 'Endpoint'): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label} URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be http/https (got "${parsed.protocol}")`);
  }
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const normalized = normalizeHost(bare);
  if (METADATA_PATTERNS.some((re) => re.test(bare) || re.test(normalized))) {
    throw new Error(`${label} may not target a cloud-metadata address: ${rawUrl}`);
  }
}

/** Object-storage flavour of {@link assertNonMetadataUrl} (the "Test connection" probe). */
export function validateStorageEndpoint(rawUrl: string): void {
  assertNonMetadataUrl(rawUrl, 'Storage endpoint');
}

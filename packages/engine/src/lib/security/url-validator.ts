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

/**
 * Exported so the edge-function subprocess bootstrap — which runs as a
 * standalone `.mjs` and cannot import this module — can inline this function's
 * own source instead of keeping a hand-written copy of it. See
 * `edge-functions/subprocess-runner.ts`.
 */
export function intToIPv4(n: number): string {
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

export const BLOCKED_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\.\d+\.\d+\.\d+$/, // 127.0.0.0/8
  /^10\.\d+\.\d+\.\d+$/, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // 172.16.0.0/12
  /^192\.168\.\d+\.\d+$/, // 192.168.0.0/16
  /^169\.254\.\d+\.\d+$/, // 169.254.0.0/16 (link-local / cloud metadata)
  // 192.0.0.192 — Oracle Cloud's instance metadata service. It is NOT link-local
  // and NOT private: 192.0.0.0/24 is a globally-routable IANA special-purpose
  // block, so it passes every range test above and reads as an ordinary public
  // address. That is what makes it worth naming individually — the reasoning
  // that catches 169.254.169.254 does not catch this one, and it hands out the
  // same thing: cloud credentials.
  /^192\.0\.0\.192$/,
  // 100.64.0.0/10 — RFC 6598 shared address space. Not RFC 1918, which is why
  // it was missing: it is "carrier-grade NAT" space, and reads like someone
  // else's problem. It is not. Several managed Kubernetes offerings put pod and
  // service networks in it, Tailscale hands out 100.64/10 addresses, and a
  // number of hosts run their internal fabric there — so on a good many
  // installs this is the range the interesting internal services actually sit
  // in. Written as two alternatives because /10 stops at 100.127, and 100.128+
  // is ordinary public space that must keep working.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/, // 100.64.0.0/10
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
 * Returns the address to connect to, so a caller can close the DNS rebinding
 * race (resolve → public, connect → private) rather than reasoning about it.
 * This was once recorded here as unclosable — "fetch offers no way to pin the
 * connection" — which is untrue of this runtime: requesting the IP with an
 * explicit Host header and a TLS serverName connects where we decided and still
 * verifies the certificate for the name. `safeFetch` does exactly that.
 */
export async function assertPublicUrl(rawUrl: string): Promise<string | null> {
  validatePublicUrl(rawUrl);

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) return null;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return null;
  }

  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new Error(
        `Network access to internal/private address blocked: ${rawUrl} resolves to ${address}`,
      );
    }
  }

  // The address the caller should CONNECT to. Returning it is what lets a
  // caller close the rebinding race: checking a NAME and then handing the name
  // to fetch resolves it a second time, and only the first was inspected. Null
  // means there is nothing to pin — an IP literal, or a name that did not
  // resolve and so cannot be reached either.
  return addresses.length ? addresses[0].address : null;
}

/**
 * The blocklist, as JavaScript source, for a sandbox that cannot import it.
 *
 * Both edge-function sandboxes run user code somewhere this module is
 * unreachable — a standalone `.mjs` for the subprocess, a `data:` URL Worker
 * for the in-process runner — so each needs the guard to exist inside its own
 * bootstrap string. Each used to carry a hand-written copy (and the Worker one
 * carried nothing at all, handing user code the parent's raw `fetch`). A copy
 * drifted: `192.0.0.192` and `100.64.0.0/10` were added here and never reached
 * it, and the subprocess fetched both.
 *
 * So the bootstraps interpolate this instead. It emits `_isBlockedHost`,
 * `_validateUrl` and — when the host can resolve names — `_assertUrl`, built
 * from the very functions above via `Function.prototype.toString`, so a pattern
 * added to {@link BLOCKED_PATTERNS} is in every sandbox from the same commit.
 *
 * `dnsLookupExpr` is JS source for a `lookup(host, {all:true})`-shaped function,
 * and it is REQUIRED: a guard that only inspects how a host is SPELLED is the
 * hole this whole module exists to close, so there is deliberately no variant
 * that omits it. Both bootstraps get one from a static import evaluated before
 * lockdown, while `require` and `process` are still reachable.
 */
export function buildSandboxSsrfGuardSource(dnsLookupExpr: string): string {
  const shared = `
const _BLOCKED = [${BLOCKED_PATTERNS.map((re) => re.toString()).join(', ')}];
const _intToIPv4 = ${intToIPv4.toString()};
const _normalizeHost = ${normalizeHost.toString().replace(/\bintToIPv4\(/g, '_intToIPv4(')};
const _isBlockedHost = ${isBlockedHost
    .toString()
    .replace(/\bnormalizeHost\(/g, '_normalizeHost(')
    .replace(/\bBLOCKED_PATTERNS\b/g, '_BLOCKED')};
function _validateUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) { throw new Error('[sandbox] Invalid URL: ' + rawUrl); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('[sandbox] Only http/https URLs are allowed (got "' + parsed.protocol + '")');
  }
  if (_isBlockedHost(parsed.hostname.toLowerCase())) {
    throw new Error('[sandbox] Network access to internal/private address blocked: ' + rawUrl);
  }
  return parsed;
}
function _isIpLiteral(host) {
  if (host.indexOf(':') !== -1) return true;
  return /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(_normalizeHost(host));
}
`;

  return `${shared}
const _dnsLookup = ${dnsLookupExpr};
// DNS-aware guard — the literal blocklist never inspects what a HOSTNAME
// resolves to, so untrusted code could otherwise reach cloud metadata through
// an attacker-owned name. An unresolvable host is allowed through: fetch cannot
// reach it either.
//
// Returns the address the caller should CONNECT to, or null when there is
// nothing to pin (an IP literal, or a name that would not resolve). See
// _pinnedFetch for why that matters.
async function _assertUrl(rawUrl) {
  const parsed = _validateUrl(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
  if (_isIpLiteral(host)) return null;
  let addrs;
  try { addrs = await _dnsLookup(host, { all: true }); } catch (_) { return null; }
  for (const a of addrs) {
    if (_isBlockedHost(a.address)) {
      throw new Error(
        '[sandbox] Network access to internal/private address blocked: ' +
          rawUrl + ' resolves to ' + a.address,
      );
    }
  }
  return addrs.length ? addrs[0].address : null;
}
`;
}

/**
 * A `safeFetch` for a sandbox bootstrap, in JavaScript source. Depends on
 * `_assertUrl` from {@link buildSandboxSsrfGuardSource} and on a captured
 * `_fetch`. Validates the target and re-validates every redirect hop, because a
 * public host that 302s to 169.254.169.254 is the same attack with one more
 * step in it.
 */
export function buildSandboxSafeFetchSource(): string {
  return `
// Connect to the address that was VALIDATED, not to whatever the name resolves
// to on the second lookup.
//
// Checking a name and then handing the NAME to fetch leaves a rebinding race:
// the guard resolves to a public address, fetch resolves again a moment later,
// and the attacker's zone has by then started answering 169.254.169.254. The
// check is real and the connection still lands inside. That was written down
// here as unclosable — "fetch offers no way to pin the connection" — and it is
// untrue of this runtime: requesting the IP with an explicit Host header and a
// TLS serverName connects where we decided and still presents and verifies the
// right certificate. Measured against a real host before it was written.
//
// Where there is nothing to pin (an IP literal, or a name that did not resolve)
// the URL is passed through unchanged.
async function _pinnedFetch(url, init, address) {
  if (!address) return _fetch(url, init);
  const parsed = new URL(url);
  const pinned = new URL(url);
  pinned.hostname = address.indexOf(':') !== -1 ? '[' + address + ']' : address;
  const headers = new Headers((init && init.headers) || undefined);
  // 'host' carries the port when there is one: a vhost is chosen by authority,
  // not by hostname alone.
  headers.set('host', parsed.host);
  const opts = Object.assign({}, init || {}, { headers: headers });
  if (parsed.protocol === 'https:') {
    // Without serverName the certificate is checked against the IP and every
    // request fails; with it this is an ordinary verified TLS connection, to a
    // host we chose rather than one the resolver chose twice.
    opts.tls = Object.assign({}, opts.tls || {}, { serverName: parsed.hostname });
  }
  return _fetch(pinned.toString(), opts);
}

async function safeFetch(input, init, _hops) {
  _hops = _hops || 0;
  let _url;
  if (typeof input === 'string') _url = input;
  else if (input && typeof input === 'object' && input.url) _url = input.url;
  else _url = String(input);
  const _pin = await _assertUrl(_url);
  if (_hops > 5) throw new Error('[sandbox] Too many redirects.');
  const _res = await _pinnedFetch(_url, Object.assign({}, init || {}, { redirect: 'manual' }), _pin);
  if (_res.status >= 300 && _res.status < 400) {
    const _loc = _res.headers.get('location');
    if (!_loc) throw new Error('[sandbox] Redirect with no Location header blocked.');
    return safeFetch(new URL(_loc, _url).toString(), init, _hops + 1);
  }
  return _res;
}
`;
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
  // Oracle Cloud's IMDS is NOT link-local. 192.0.0.192 sits in 192.0.0.0/24, a
  // globally-routable IANA special-purpose block, so every pattern above misses
  // it and so does any "is this a private address" test — which is exactly what
  // makes it the one worth naming: it looks public to a check that reasons about
  // ranges. Same class as the denylists inverted elsewhere in this codebase, and
  // it cannot be inverted here (an object-storage endpoint is legitimately any
  // host), so the enumeration has to be right.
  /^192\.0\.0\.192$/,
  /(^|\.)metadata\.google\.internal$/,
  /(^|\.)metadata\.azure\.com$/,
  /(^|\.)metadata\.oraclecloud\.com$/,
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

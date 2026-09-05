/**
 * Who the request actually came from — one answer, for everything that asks.
 *
 * The rate limiter has always been careful here: proxy headers are believed
 * only behind `TRUSTED_PROXY`, and only when they parse as an address, because
 * a caller that can name itself can dodge its own limit. Three other call sites
 * asked the same question and simply took the header:
 *
 *   - `god-audit` writes it to `zv_audit_log`. That is the accountability record
 *     for the one role that bypasses every permission check, so the subject of
 *     the audit was choosing what the audit said about them.
 *   - `request-log` writes it to `zv_request_logs`.
 *   - `routes/permissions.ts` records it on every refused recovery-token attempt
 *     — an endpoint whose own comment says a failed attempt is the attack, not
 *     noise.
 *
 * None of those are a bypass on their own. Together they are a forgeable
 * forensic trail, which is worse than an absent one: it invites belief. The
 * resolver lives here so the careful answer is the easy one to reach for.
 */

import type { Context } from 'hono';

/**
 * Normalise a peer address to a bare IPv4 when it is an IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`), which is what Bun reports for IPv4 clients. Without this
 * the CIDR lists never match and every mapped client gets its own odd bucket key.
 */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

// Strict octets: a looser \d{1,3} would accept 999.999.999.999 and waste
// rate-limit slots — and audit rows — on bogus identifiers.
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]{2,39}$/i;

// One-shot warning per process if a deployment looks like it's behind a
// proxy (forwarded headers present) but TRUSTED_PROXY isn't set. Without
// the env var, the forwarded IP is ignored and every client behind that
// proxy shares the same rate-limit bucket — which means one abusive client
// can DoS everyone else, or one well-behaved client gets blocked because
// another behind the same proxy is hammering.
let _proxyHintWarned = false;
function maybeWarnProxyMisconfig(c: Context): void {
  if (_proxyHintWarned) return;
  if (process.env.TRUSTED_PROXY === 'true') return;
  const hasFwd = !!(
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    c.req.header('forwarded')
  );
  if (!hasFwd) return;
  _proxyHintWarned = true;
  console.warn(
    '[client-ip] X-Forwarded-For/X-Real-IP detected but TRUSTED_PROXY ' +
      'is not set — all clients behind the proxy share the same rate-limit ' +
      'bucket. Set TRUSTED_PROXY=true ONLY if your edge/proxy strips BOTH ' +
      'inbound X-Forwarded-For AND X-Real-IP before re-setting them, ' +
      'otherwise clients can spoof their IP. Naming only X-Forwarded-For ' +
      'here was itself a bug: both headers are trusted when the flag is set.',
  );
}

/**
 * Client IP, honouring proxy headers ONLY behind TRUSTED_PROXY (otherwise any
 * client could spoof its identity and dodge the limit, or sign someone else's
 * name in the audit log). `'unknown'` when there is nothing trustworthy to say.
 */
export function resolveClientIp(c: Context): string {
  maybeWarnProxyMisconfig(c);
  const trustedProxy = process.env.TRUSTED_PROXY === 'true';
  const rawForwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const forwardedIp =
    trustedProxy &&
    rawForwardedFor &&
    (IPV4_RE.test(rawForwardedFor) || IPV6_RE.test(rawForwardedFor))
      ? rawForwardedFor
      : null;
  // Validated with the same patterns as X-Forwarded-For. It used to be taken
  // verbatim, and it is the rate-limit IDENTITY: measured, a client sending a
  // different junk X-Real-IP per request got five 200s against a limit of two,
  // because every distinct string is its own bucket.
  const rawRealIp = c.req.header('x-real-ip')?.trim();
  const realIp =
    trustedProxy && rawRealIp && (IPV4_RE.test(rawRealIp) || IPV6_RE.test(rawRealIp))
      ? rawRealIp
      : null;
  // Last resort: the TCP peer. Without it, ALL unauthenticated non-proxied
  // traffic collapses onto one `rl:<tier>:unknown` bucket — so a single abusive
  // client can 429 every other anonymous client (a login DoS on /api/auth/*).
  //
  // Bun hands `{ server }` to fetch (see Bun.serve in index.ts) and exposes the
  // peer via `server.requestIP(req)`. The previous `env.ip` / `env.incoming`
  // reads are Node-adapter shapes and were ALWAYS undefined here, so this
  // protection silently did nothing. Node shape kept as a fallback.
  // biome-ignore lint/suspicious/noExplicitAny: hono env is adapter-specific
  const env = c.env as any;
  const connectionIp: string | undefined =
    normalizeIp(env?.server?.requestIP?.(c.req.raw)?.address) ??
    normalizeIp(env?.incoming?.socket?.remoteAddress);
  return forwardedIp || realIp || connectionIp || 'unknown';
}

/**
 * The same answer, shaped for a record rather than a bucket key.
 *
 * `'unknown'` becomes `null`. A limiter needs *some* key and one shared bucket
 * for unidentifiable callers is the safe reading; an audit row wants the field
 * empty instead of carrying a word that will be read as an address by the next
 * person to query the table.
 */
export function clientIpForAudit(c: Context): string | null {
  const ip = resolveClientIp(c);
  return ip === 'unknown' ? null : ip;
}

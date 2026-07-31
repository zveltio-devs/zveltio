/**
 * Origin check for WebSocket upgrades (cross-site WebSocket hijacking).
 *
 * The WS route authenticates the session cookie, which is not enough. The
 * same-origin policy does not apply to WebSocket handshakes, and browsers send
 * cookies with them regardless of which page opened the socket. So any page the
 * victim visits can do:
 *
 *   new WebSocket('wss://their-zveltio.example/api/ws')
 *
 * and get a fully authenticated connection to someone else's instance —
 * subscribing to record events, reading everything the user can read. The
 * session check passes precisely because the browser attached the real cookie.
 * `Origin` is the only signal that distinguishes it from the real app.
 *
 * **A missing Origin is allowed.** Non-browser clients — the CLI, server-to-
 * server consumers, tests — do not send one, and they are not the threat: this
 * attack works because a browser attaches credentials automatically. A client
 * that already holds the cookie gains nothing from omitting a header. Rejecting
 * would break every legitimate non-browser consumer to stop nobody.
 *
 * **Without CORS_ORIGINS we require same-origin** rather than replicating the
 * auth module's interface-scanning allowlist. The browser sets `Origin` to the
 * page's origin and `Host` to what it connected to, so demanding they match
 * covers localhost, a LAN IP and a real domain without configuration — and
 * cannot drift from a second copy of the list.
 */

export interface OriginVerdict {
  allowed: boolean;
  /** Logged on refusal so an operator can tell misconfiguration from attack. */
  reason: string;
}

function configuredOrigins(): string[] | null {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Normalise for comparison: origins are case-insensitive, trailing / is noise. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Whether a WebSocket upgrade carrying `origin` may proceed.
 *
 * `host` is the request's Host header — used only for the same-origin fallback
 * when no explicit allowlist is configured.
 */
export function checkWsOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): OriginVerdict {
  if (!origin) {
    return { allowed: true, reason: 'no Origin header (non-browser client)' };
  }

  const allowlist = configuredOrigins();
  if (allowlist) {
    // `*` is accepted because an operator who writes it has said what they
    // mean. It is still recorded in the reason, so a refusal elsewhere is never
    // confused with a wide-open allowlist.
    if (allowlist.includes('*')) return { allowed: true, reason: 'CORS_ORIGINS contains *' };
    const wanted = normalise(origin);
    const ok = allowlist.some((o) => normalise(o) === wanted);
    return ok
      ? { allowed: true, reason: 'origin is in CORS_ORIGINS' }
      : { allowed: false, reason: `origin ${origin} is not in CORS_ORIGINS` };
  }

  if (!host) {
    return { allowed: false, reason: 'Origin present but no Host header to compare against' };
  }

  // Same-origin: the Origin's host[:port] must equal the Host header.
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { allowed: false, reason: `malformed Origin header: ${origin}` };
  }

  const ok = normalise(originHost) === normalise(host);
  return ok
    ? { allowed: true, reason: 'same-origin' }
    : {
        allowed: false,
        reason:
          `cross-origin WebSocket from ${origin} to host ${host}. ` +
          `Set CORS_ORIGINS if this origin is legitimate.`,
      };
}

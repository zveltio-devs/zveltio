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
 * **Same-origin is always allowed**, before any allowlist is consulted. The
 * browser sets `Origin` to the page's origin and `Host` to what it connected to,
 * so demanding they match covers localhost, a LAN IP and a real domain without
 * configuration — and cannot drift from a second copy of the list. It is checked
 * first because the Studio is served by this engine: its origin is not something
 * an operator should have to declare, and requiring it in `CORS_ORIGINS` broke
 * realtime on every instance where that list was set for a separate frontend.
 *
 * `CORS_ORIGINS` then widens the set for genuinely cross-origin clients.
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

  // Same-origin is allowed BEFORE the allowlist is consulted, not after.
  //
  // The Studio is served BY this engine, so its origin is whatever the operator
  // reached the engine on. Requiring that to also appear in `CORS_ORIGINS` makes
  // the app's own socket depend on a list that exists to describe OTHER origins —
  // and `.env.example` tells operators to set that list, for their frontend. The
  // moment they do, realtime in the admin UI stops, silently, with the reason
  // only in the server log.
  //
  // Measured: an engine on 127.0.0.1:3300 serving its own Studio refused every
  // upgrade with `origin http://127.0.0.1:3300 is not in CORS_ORIGINS`, because
  // the list named three other ports.
  //
  // This cannot weaken the guard. The attack is a page on ANOTHER origin opening
  // a socket with the victim's cookie attached; such a page has a different
  // `Origin` by definition, and browsers set `Host` to what was connected to.
  // An Origin that equals the Host is the application itself.
  if (origin && host && isSameOrigin(origin, host)) {
    return { allowed: true, reason: 'same-origin' };
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

  // Reaching here means not same-origin (checked above) and no allowlist.
  return {
    allowed: false,
    reason:
      `cross-origin WebSocket from ${origin} to host ${host}. ` +
      `Set CORS_ORIGINS if this origin is legitimate.`,
  };
}

/** Whether `origin`'s host[:port] equals the Host header. Malformed → false. */
function isSameOrigin(origin: string, host: string): boolean {
  try {
    return normalise(new URL(origin).host) === normalise(host);
  } catch {
    return false;
  }
}

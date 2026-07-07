/**
 * Minimal HTTP helpers for the benchmark suite.
 *
 * We deliberately use Bun's built-in `fetch` over a heavier client.
 * The benchmark measures Zveltio + network + serialization end-to-end,
 * which is what consumers actually feel. We're NOT trying to bypass
 * the network stack to get artificial numbers.
 */

export interface BenchHttpClient {
  baseUrl: string;
  /**
   * Either:
   *   - a `Cookie` header value (e.g. `better-auth.session_token=…`), OR
   *   - an API key starting with `zvk_` (sent as Authorization: Bearer).
   *
   * The engine accepts both forms on admin routes; we auto-detect which
   * one based on the prefix. Cookie is the default because /api/auth/
   * sign-in/email sets a session cookie, not an API key.
   */
  authToken?: string;
}

/** Pick the right auth header for the token shape. */
function authHeader(client: BenchHttpClient): Record<string, string> {
  if (!client.authToken) return {};
  if (client.authToken.startsWith('zvk_')) {
    return { Authorization: `Bearer ${client.authToken}` };
  }
  return { Cookie: client.authToken };
}

export interface TimedResponse {
  status: number;
  durationMs: number;
  body?: unknown;
}

/**
 * GET + return wall-clock duration + parsed JSON.
 */
export async function timedGet(client: BenchHttpClient, path: string): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'GET',
    headers: authHeader(client),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * POST + return wall-clock duration + parsed JSON.
 */
export async function timedPost(
  client: BenchHttpClient,
  path: string,
  payload: unknown,
): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(client),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * PATCH + return wall-clock duration + parsed JSON.
 */
export async function timedPatch(
  client: BenchHttpClient,
  path: string,
  payload: unknown,
): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(client),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * DELETE + return wall-clock duration + parsed JSON.
 */
export async function timedDelete(client: BenchHttpClient, path: string): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeader(client),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * Wait for the engine to respond 200 on /api/health. Returns the time
 * it took (used for cold-start benchmarks).
 */
export async function waitForHealthy(baseUrl: string, timeoutMs = 60_000): Promise<number> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return performance.now() - t0;
    } catch {
      /* connection refused — engine not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`engine did not become healthy within ${timeoutMs}ms`);
}

/**
 * Sign in via better-auth and return the `Cookie` header value to use
 * on subsequent authenticated requests.
 *
 * Admin routes call `auth.api.getSession({ headers })`, which reads the
 * session cookie that better-auth set during sign-in — there is no
 * "Authorization: Bearer <session-token>" path. So we capture the
 * Set-Cookie response header and replay it verbatim.
 *
 * For benchmarks that *do* want API-key auth (a hot path closer to
 * production SDK consumers), create an API key via /api/admin/api-keys
 * and pass the `zvk_…` string as `authToken` — the helper auto-detects
 * the prefix and uses Authorization: Bearer.
 */
export async function signInForToken(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sign-in failed: ${res.status} ${body.slice(0, 200)}`);
  }

  // Better-auth uses Set-Cookie. fetch in Bun/Node 18+ supports getSetCookie()
  // which preserves multi-cookie semantics; fall back to raw header parsing.
  const setCookies =
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    (res.headers as any).getSetCookie?.() ??
    res.headers.get('set-cookie')?.split(/,(?=[^;]+=)/g) ??
    [];

  // Extract just the `name=value` part of each cookie (drop attributes like
  // Path/HttpOnly/Expires) and join — that's what a browser sends back.
  const cookieHeader = (setCookies as string[])
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  if (!cookieHeader) {
    throw new Error('sign-in succeeded but no session cookie was set — engine misconfigured?');
  }
  return cookieHeader;
}

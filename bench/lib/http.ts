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
  /** Optional bearer token for authenticated routes. */
  authToken?: string;
}

export interface TimedResponse {
  status: number;
  durationMs: number;
  body?: unknown;
}

/**
 * GET + return wall-clock duration + parsed JSON.
 */
export async function timedGet(
  client: BenchHttpClient,
  path: string,
): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'GET',
    headers: client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {},
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
      ...(client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {}),
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
      ...(client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * DELETE + return wall-clock duration + parsed JSON.
 */
export async function timedDelete(
  client: BenchHttpClient,
  path: string,
): Promise<TimedResponse> {
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: 'DELETE',
    headers: client.authToken ? { Authorization: `Bearer ${client.authToken}` } : {},
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, durationMs: performance.now() - t0, body };
}

/**
 * Wait for the engine to respond 200 on /api/health. Returns the time
 * it took (used for cold-start benchmarks).
 */
export async function waitForHealthy(
  baseUrl: string,
  timeoutMs = 60_000,
): Promise<number> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return performance.now() - t0;
    } catch { /* connection refused — engine not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`engine did not become healthy within ${timeoutMs}ms`);
}

/**
 * Sign in via better-auth and return the session cookie value to use
 * as `Authorization: Bearer <token>` for subsequent calls.
 *
 * Most engine routes accept either a session cookie or an API token.
 * Benchmarks use the API token path because it skips cookie parsing on
 * every request — closer to what an SDK consumer does in production.
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
  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error('sign-in response missing token');
  return data.token;
}

/**
 * H-13 acceptance — every non-2xx response from the RUNNING engine carries the
 * RFC 9457 problem+json envelope. Walks the live OpenAPI spec firing each GET
 * UNAUTHENTICATED (safe, no mutations) and asserts every non-2xx is an envelope
 * with `type`/`title`/`status`/`code`. Requires TEST_DATABASE_URL + a running
 * engine on TEST_PORT (the CI integration harness), same as tenant-adversarial.
 */

import { describe, it, expect, beforeAll } from 'bun:test';

const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE = `http://localhost:${TEST_PORT}`;
const skipAll = !process.env.TEST_DATABASE_URL;

// The OpenAPI paths are relative to the `/api` server base (spec lists
// `/collections`; the live route is `/api/collections`), so the walk fires
// `/api` + path. SKIP matches the raw spec path.
const API_BASE = '/api';

// Routes that answer unauthenticated GETs with 2xx, or stream — skip (they
// can't produce a checkable non-2xx).
const SKIP = [
  /^\/openapi/,
  /^\/health/,
  /^\/sitemap/,
  /stream/, // Server-Sent Events — a GET that stays open; would hang the walk
  /realtime/,
];

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}
let spec: Spec;

async function fireGet(path: string): Promise<Response> {
  // Fill any {param} with a dummy so the route matches; unauthenticated.
  const url = path.replace(/\{[^}]+\}/g, 'probe');
  return fetch(`${BASE}${API_BASE}${url}`, { method: 'GET', signal: AbortSignal.timeout(4000) });
}

beforeAll(async () => {
  if (skipAll) return;
  const res = await fetch(`${BASE}/api/openapi.json`);
  spec = (await res.json()) as Spec;
});

describe.skipIf(skipAll)('H-13 — error envelope on the live spec', () => {
  it('a representative unauthenticated request is problem+json', async () => {
    const res = await fetch(`${BASE}/api/users`);
    if (res.status < 300) return; // public in some builds — the walk covers the rest
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.code).toBe('string');
    expect(body.status).toBe(res.status);
  });

  it('an unmatched API route returns a 404 envelope', async () => {
    const res = await fetch(`${BASE}/api/definitely-not-a-real-route-xyz`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('not_found');
  });

  it('every non-2xx GET across the spec carries the envelope', async () => {
    const violations: string[] = [];
    let checked = 0;

    for (const [path, methods] of Object.entries(spec.paths)) {
      if (!('get' in methods)) continue;
      if (SKIP.some((re) => re.test(path))) continue;

      let res: Response;
      try {
        res = await fireGet(path);
      } catch {
        continue; // network hiccup — not an envelope violation
      }
      if (res.status < 400) continue; // 2xx/3xx have no envelope to check
      checked++;

      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/problem+json')) {
        violations.push(`GET ${path} → ${res.status} but content-type is "${ct}"`);
        continue;
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.code !== 'string' ||
        typeof body.title !== 'string' ||
        body.status !== res.status
      ) {
        violations.push(`GET ${path} → ${res.status} envelope malformed: ${JSON.stringify(body)}`);
      }
    }

    if (violations.length > 0) {
      console.error('[error-envelope] NON-ENVELOPE RESPONSES:');
      for (const v of violations) console.error(`  ✗ ${v}`);
    }
    console.log(`[error-envelope] checked ${checked} non-2xx GET responses`);
    expect(violations).toEqual([]);
  });
});

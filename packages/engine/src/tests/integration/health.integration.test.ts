/**
 * Health — Integration Tests
 *
 * Tests the health, version and metrics endpoints.
 * Requires a running engine on TEST_PORT (no database needed).
 *
 * Run with:
 * TEST_PORT=3099 bun test packages/engine/src/tests/integration/health.integration.test.ts
 */

import { describe, it, expect } from 'bun:test';

const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe('Health — Integration', () => {
  it('GET /api/health — returns status ok', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
  });

  it('GET /api/health — does NOT leak version/runtime info', async () => {
    // Public /health must stay minimal — engine/schema/runtime details live
    // behind /version (auth-gated) per the security-sprint remediation.
    const res = await fetch(`${BASE_URL}/api/health`);
    const body = await res.json() as any;
    expect(body.engine).toBeUndefined();
    expect(body.schema).toBeUndefined();
    expect(body.runtime).toBeUndefined();
    expect(body.platform).toBeUndefined();
    expect(body.checks).toBeUndefined();
    expect(typeof body.timestamp).toBe('string');
  });

  it('GET /metrics — exposes Prometheus metrics', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('zveltio_requests_total');
  });

  it('GET /api/health/version — requires auth (was public, now gated)', async () => {
    // Unauthenticated — expect 401. Authenticated smoke is covered in the
    // admin-flows test where we already have a session cookie.
    const res = await fetch(`${BASE_URL}/api/health/version`);
    expect(res.status).toBe(401);
  });

  it('GET /api/sitemap.xml — returns XML', async () => {
    const res = await fetch(`${BASE_URL}/api/sitemap.xml`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('xml');
  });
});

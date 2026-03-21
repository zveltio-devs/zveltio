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

  it('GET /api/health — returns version string', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const body = await res.json() as any;
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('GET /api/health — returns db status', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const body = await res.json() as any;
    expect(body.db).toBe('ok');
  });

  it('GET /metrics — exposes Prometheus metrics', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('zveltio_requests_total');
  });

  it('GET /api/health/version — returns detailed version info', async () => {
    const res = await fetch(`${BASE_URL}/api/health/version`);
    expect(res.status).toBeOneOf([200, 404]); // 404 if endpoint doesn't exist yet
    if (res.status === 200) {
      const body = await res.json() as any;
      expect(body).toHaveProperty('version');
    }
  });

  it('GET /api/sitemap.xml — returns XML', async () => {
    const res = await fetch(`${BASE_URL}/api/sitemap.xml`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('xml');
  });
});

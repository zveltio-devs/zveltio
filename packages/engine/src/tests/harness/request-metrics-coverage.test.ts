/**
 * The request-count / Prometheus middleware must wrap every route, not just
 * the ones registered after it.
 *
 * `buildHonoApp()` used to register the counting `app.use('*', ...)` right
 * above `/metrics`, AFTER `registerCoreRoutes()` had already mounted the
 * entire `/api/*` surface and after the plain `/health` route. Hono composes
 * matched handlers in registration order: a route that returns without
 * calling `next()` never reaches a `next()`-based middleware registered later
 * for the same path. So `/api/health`, `/api/settings`, `/api/extensions` —
 * effectively the whole product's real traffic — never incremented
 * `zveltio_requests_total` or `http_requests_total`, while a request that
 * happened to miss every route and fall through to the `/api/*` 404 guard
 * (registered after the old middleware position) was counted every time.
 *
 * Skips without a test database.
 */

import { describe, expect, it } from 'bun:test';
import { getDomainMetricsLines } from '../../lib/runtime/telemetry.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

// The metric objects are module-level singletons shared with every other test
// file in the process — assert on the delta this test causes, not on an
// absolute value. See telemetry-metrics.test.ts for the same reasoning.
function sampleValue(lines: string[], prefix: string): number {
  const hit = lines.find((l) => l.startsWith(prefix));
  if (!hit) return 0;
  return Number(hit.slice(hit.lastIndexOf(' ') + 1));
}

d('request-count middleware covers every route (in-process)', () => {
  it('a real, public, already-mounted core route (/api/health) is counted', async () => {
    const { app } = await getTestApp();
    const label = 'http_requests_total{method="GET",status="200"}';
    const before = sampleValue(getDomainMetricsLines(), label);

    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const after = sampleValue(getDomainMetricsLines(), label);
    expect(after).toBe(before + 1);
  });

  it('a route mounted through registerCoreRoutes but requiring auth (/api/settings) is counted', async () => {
    const { app } = await getTestApp();
    const label = 'http_requests_total{method="GET",status="401"}';
    const before = sampleValue(getDomainMetricsLines(), label);

    const res = await app.request('/api/settings');
    expect(res.status).toBe(401);

    const after = sampleValue(getDomainMetricsLines(), label);
    expect(after).toBe(before + 1);
  });
});

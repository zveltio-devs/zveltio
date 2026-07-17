/**
 * Prometheus serialization for the domain metrics that power the Grafana
 * dashboards. These were shipped but never emitted (dashboards read "No data");
 * this locks the output FORMAT so a scrape stays parseable and the dashboards
 * keep getting data.
 */

import { describe, expect, it } from 'bun:test';
import {
  gaugeLine,
  getDomainMetricsLines,
  httpRequests,
  webhookDeliveries,
} from '../../lib/runtime/telemetry.js';

// The metric objects are MODULE-LEVEL singletons, so any other test file in the
// same bun process contributes to their counts. Assert on shape and on relative
// deltas, never on absolute values — an exact-count assertion here passes alone
// and fails in the full suite (the classic order-dependent test).
function sampleValue(lines: string[], prefix: string): number | null {
  const hit = lines.find((l) => l.startsWith(prefix));
  if (!hit) return null;
  return Number(hit.slice(hit.lastIndexOf(' ') + 1));
}

describe('telemetry metric serialization', () => {
  it('a counter emits HELP/TYPE + labeled samples once incremented', () => {
    const before =
      sampleValue(getDomainMetricsLines(), 'http_requests_total{method="GET",status="200"}') ?? 0;
    httpRequests.inc({ method: 'GET', status: '200' });
    httpRequests.inc({ method: 'GET', status: '200' });
    httpRequests.inc({ method: 'POST', status: '404' });

    const lines = getDomainMetricsLines();
    expect(lines).toContain('# TYPE http_requests_total counter');
    // Labels serialise sorted + quoted, and the two increments landed.
    expect(sampleValue(lines, 'http_requests_total{method="GET",status="200"}')).toBe(before + 2);
    expect(
      lines.some((l) => /^http_requests_total\{method="POST",status="404"\} \d+$/.test(l)),
    ).toBe(true);
  });

  it('webhook status labels round-trip', () => {
    webhookDeliveries.inc({ status: 'success' });
    webhookDeliveries.inc({ status: 'failed' });
    const lines = getDomainMetricsLines();
    expect(lines.some((l) => /^webhook_deliveries_total\{status="success"\} \d+$/.test(l))).toBe(
      true,
    );
    expect(lines.some((l) => /^webhook_deliveries_total\{status="failed"\} \d+$/.test(l))).toBe(
      true,
    );
  });

  it('gaugeLine formats a valid gauge and drops non-finite values', () => {
    expect(gaugeLine('webhook_queue_pending', 'x', 3)).toEqual([
      '# HELP webhook_queue_pending x',
      '# TYPE webhook_queue_pending gauge',
      'webhook_queue_pending 3',
    ]);
    expect(gaugeLine('x', 'y', Number.NaN)).toEqual([]);
  });
});

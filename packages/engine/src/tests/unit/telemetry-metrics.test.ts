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

describe('telemetry metric serialization', () => {
  it('a counter emits HELP/TYPE + labeled samples once incremented', () => {
    httpRequests.inc({ method: 'GET', status: '200' });
    httpRequests.inc({ method: 'GET', status: '200' });
    httpRequests.inc({ method: 'POST', status: '404' });
    const lines = getDomainMetricsLines();
    expect(lines).toContain('# TYPE http_requests_total counter');
    expect(lines.some((l) => l === 'http_requests_total{method="GET",status="200"} 2')).toBe(true);
    expect(lines.some((l) => l === 'http_requests_total{method="POST",status="404"} 1')).toBe(true);
  });

  it('webhook status labels round-trip', () => {
    webhookDeliveries.inc({ status: 'success' });
    webhookDeliveries.inc({ status: 'failed' });
    const lines = getDomainMetricsLines();
    expect(lines).toContain('webhook_deliveries_total{status="success"} 1');
    expect(lines).toContain('webhook_deliveries_total{status="failed"} 1');
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

/**
 * Telemetry (lib/runtime/telemetry.ts) — the OTel-independent surface.
 *
 * The Prometheus labeled counter/histogram formatters and the zone/view
 * metric lines are pure. `traced` runs against the global no-op tracer when
 * OTel isn't configured (span callback still executes + error propagates).
 * `tracedQuery`/`initTelemetry` are pinned on their no-endpoint fast paths.
 * The exported metric singletons accumulate process-wide, so assertions read
 * deltas / substrings rather than exact global counts.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  getTracer,
  getZoneMetricsLines,
  initTelemetry,
  traced,
  tracedQuery,
  viewQueryDuration,
  zoneAccessDenied,
  zoneRenderRequests,
} from '../../lib/runtime/telemetry.js';

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe('labeled counter (via zoneRenderRequests)', () => {
  it('emits HELP/TYPE headers and a per-label-set line once incremented', () => {
    zoneRenderRequests.inc({ zone_slug: 'home', page_slug: 'landing' });
    zoneRenderRequests.inc({ zone_slug: 'home', page_slug: 'landing' });
    const lines = zoneRenderRequests.toPrometheusLines('zone_render_requests_total', 'help text');

    expect(lines[0]).toBe('# HELP zone_render_requests_total help text');
    expect(lines[1]).toBe('# TYPE zone_render_requests_total counter');
    const dataLine = lines.find((l) => l.includes('zone_slug="home"'));
    expect(dataLine).toBeDefined();
    // labels are sorted alphabetically and the count is on the end
    expect(dataLine).toContain('page_slug="landing"');
    expect(dataLine!.trim().endsWith(' 2')).toBe(true);
  });

  it('escapes double quotes in label values', () => {
    zoneAccessDenied.inc({ zone_slug: 'a"b', role: 'x' });
    const lines = zoneAccessDenied.toPrometheusLines('zone_access_denied_total', 'h');
    expect(lines.some((l) => l.includes('zone_slug="a\\"b"'))).toBe(true);
  });
});

describe('labeled histogram (via viewQueryDuration)', () => {
  it('produces bucket/sum/count lines with cumulative bucket counts', () => {
    viewQueryDuration.observe({ view_id: 'v1', collection: 'c1' }, 30);
    viewQueryDuration.observe({ view_id: 'v1', collection: 'c1' }, 300);
    const lines = viewQueryDuration.toPrometheusLines('view_query_duration_ms', 'h');

    expect(lines[1]).toBe('# TYPE view_query_duration_ms histogram');
    // 30ms falls in le="50"; 300ms does not → le="50" has count 1
    const le50 = lines.find((l) => l.includes('view_id="v1"') && l.includes('le="50"'));
    expect(le50!.trim().endsWith(' 1')).toBe(true);
    // both observations are <= +Inf
    const inf = lines.find((l) => l.includes('le="+Inf"') && l.includes('view_id="v1"'));
    expect(inf!.trim().endsWith(' 2')).toBe(true);
    // sum + count reflect both
    expect(
      lines.some((l) => l.startsWith('view_query_duration_ms_sum') && l.includes('330.000')),
    ).toBe(true);
    expect(
      lines.some((l) => l.startsWith('view_query_duration_ms_count') && l.trim().endsWith(' 2')),
    ).toBe(true);
  });
});

describe('getZoneMetricsLines', () => {
  it('concatenates all three metric families', () => {
    zoneRenderRequests.inc({ zone_slug: 'z', page_slug: 'p' });
    const lines = getZoneMetricsLines();
    expect(lines.some((l) => l.includes('zone_render_requests_total'))).toBe(true);
    // empty families contribute nothing (no throw); non-empty families appear
    expect(Array.isArray(lines)).toBe(true);
  });
});

describe('traced', () => {
  it('returns the wrapped result under the no-op tracer', async () => {
    const result = await traced('op', { a: 1, b: 'x', c: true }, async () => 'value');
    expect(result).toBe('value');
  });

  it('propagates the error from the wrapped fn', async () => {
    await expect(
      traced('op', {}, async () => {
        throw new Error('inner boom');
      }),
    ).rejects.toThrow('inner boom');
  });

  it('getTracer returns a tracer with startActiveSpan', () => {
    const tracer = getTracer();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });
});

describe('tracedQuery', () => {
  it('passes straight through to fn when no OTEL endpoint is configured', async () => {
    let ran = false;
    const out = await tracedQuery('users.list', async () => {
      ran = true;
      return [1, 2, 3];
    });
    expect(ran).toBe(true);
    expect(out).toEqual([1, 2, 3]);
  });

  it('still wraps (and returns) when an OTEL endpoint is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const out = await tracedQuery('users.get', async () => 'row');
    expect(out).toBe('row');
  });
});

describe('initTelemetry', () => {
  it('is a no-op that resolves when no OTEL endpoint is set', async () => {
    await expect(initTelemetry()).resolves.toBeUndefined();
  });
});

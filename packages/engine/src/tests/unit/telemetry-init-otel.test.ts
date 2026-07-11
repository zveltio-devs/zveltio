/**
 * initTelemetry with OTEL endpoint configured (lib/runtime/telemetry.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { initTelemetry, tracedQuery } from '../../lib/runtime/telemetry.js';

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe('initTelemetry', () => {
  it('resolves when an OTLP endpoint is set (no-op exporter in unit env)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    await expect(initTelemetry()).resolves.toBeUndefined();
    const out = await tracedQuery('probe', async () => 'ok');
    expect(out).toBe('ok');
  });
});

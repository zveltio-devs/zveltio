/**
 * initTelemetry — W3C-only propagator fallback when CompositePropagator is absent.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

mock.module('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start() {}
  },
}));

mock.module('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {},
}));

mock.module('@opentelemetry/core', () => ({
  W3CTraceContextPropagator: class W3CTraceContextPropagator {},
  W3CBaggagePropagator: class W3CBaggagePropagator {},
}));

const { initTelemetry } = await import('../../lib/runtime/telemetry.js');

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe('initTelemetry W3C-only fallback', () => {
  it('uses W3CTraceContextPropagator when CompositePropagator is unavailable', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const { propagation } = await import('@opentelemetry/api');
    const setSpy = spyOn(propagation, 'setGlobalPropagator').mockImplementation(() => true);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await initTelemetry();
      expect(setSpy).toHaveBeenCalled();
      const propagator = setSpy.mock.calls[0]?.[0] as { constructor: { name: string } };
      expect(propagator.constructor.name).toBe('W3CTraceContextPropagator');
    } finally {
      setSpy.mockRestore();
      log.mockRestore();
    }
  });
});

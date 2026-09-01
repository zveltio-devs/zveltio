/**
 * initTelemetry — non-fatal failure when the OTel SDK cannot start.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

mock.module('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    // biome-ignore lint/complexity/noUselessConstructor: types the argument. Removing it makes the class take ZERO arguments — measured: `Expected 0 arguments, but got 1` on every `new` below.
    constructor() {}
    start() {
      throw new Error('sdk start boom');
    }
  },
}));

mock.module('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {},
}));

mock.module('@opentelemetry/core', () => ({
  W3CTraceContextPropagator: class {},
  W3CBaggagePropagator: class {},
  CompositePropagator: class {
    // biome-ignore lint/complexity/noUselessConstructor: types the argument. Removing it makes the class take ZERO arguments — measured: `Expected 0 arguments, but got 1` on every `new` below.
    constructor(_opts: unknown) {}
  },
}));

const { initTelemetry } = await import('../../lib/runtime/telemetry.js');

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe('initTelemetry OTel failure path', () => {
  it('warns and resolves when NodeSDK.start throws', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(initTelemetry()).resolves.toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('OpenTelemetry init failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

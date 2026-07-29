/**
 * Tracing middleware (middleware/tracing.ts). Gated on OTEL_EXPORTER_OTLP_ENDPOINT:
 * disabled → pass-through; enabled → the SERVER-span path runs (a no-op tracer
 * when no SDK is wired, which still executes the span-lifecycle code). Also the
 * tracedFetch wrapper's enabled/disabled branches.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { tracedFetch, tracingMiddleware } from '../../middleware/tracing.js';

const SNAP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
afterEach(() => {
  if (SNAP === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = SNAP;
});

function appWithTracing() {
  const app = new Hono();
  app.use('*', tracingMiddleware());
  app.get('/ok', (c) => c.text('ok'));
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  return app;
}

describe('tracingMiddleware', () => {
  it('passes through when OTEL is disabled', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const res = await appWithTracing().request('/ok');
    expect(res.status).toBe(200);
  });

  it('runs the span path when OTEL is enabled (with + without incoming traceparent)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const app = appWithTracing();
    expect((await app.request('/ok')).status).toBe(200);
    const withCtx = await app.request('/ok', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    expect(withCtx.status).toBe(200);
  });

  it('records the exception + still surfaces the error on the span path', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const res = await appWithTracing().request('/boom');
    // The middleware records + re-raises; Hono turns the throw into a 500.
    expect(res.status).toBe(500);
  });
});

describe('tracedFetch', () => {
  it('delegates to plain fetch when OTEL is disabled', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    // Unreachable host → rejects fast; we only need the disabled branch to run.
    await expect(tracedFetch('http://127.0.0.1:1/x')).rejects.toBeDefined();
  });

  it('wraps fetch (injecting context) when OTEL is enabled', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    await expect(tracedFetch('http://127.0.0.1:1/x')).rejects.toBeDefined();
  });
});

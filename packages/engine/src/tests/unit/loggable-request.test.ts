/**
 * Credentials in a request's address never reach a trace or the slow-request log.
 *
 * The span's name and `http.route` were `c.req.path` and `http.url` was the full
 * URL, so `GET /api/invitations/<token>` exported a live invitation, and a
 * better-auth `?token=` link exported its token. The slow-request log stored the
 * path and the query as they came. Both run here against the real middleware.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { type Tracer, propagation, trace } from '@opentelemetry/api';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { slowQueryMiddleware } from '../../middleware/slow-query.js';
import { tracingMiddleware } from '../../middleware/tracing.js';

const TOKEN = 'a'.repeat(64);
// A recording tracer of our own, handed to the middleware through a spy on
// trace.getTracer — not sdk-node's exporter (another unit file mocks
// '@opentelemetry/sdk-node' process-wide) and not the global provider (the OTel
// API refuses a registration once another file, or another copy of the API,
// holds the global).
type Recorded = { name: string; attributes: Record<string, unknown> };
const finished: Recorded[] = [];
const tracer = {
  startActiveSpan: (
    name: string,
    opts: { attributes?: Record<string, unknown> },
    _ctx: unknown,
    fn: (span: unknown) => unknown,
  ) => {
    const rec: Recorded = { name, attributes: { ...opts.attributes } };
    const span = {
      setAttribute: (k: string, v: unknown) => {
        rec.attributes[k] = v;
        return span;
      },
      setStatus: () => span,
      recordException: () => undefined,
      end: () => finished.push(rec),
    };
    return fn(span);
  },
} as unknown as Tracer;
let getTracer: ReturnType<typeof spyOn>;
const prevEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

beforeAll(() => {
  getTracer = spyOn(trace, 'getTracer').mockReturnValue(tracer);
  // telemetry-init-otel-failure.test.ts leaves a mocked CompositePropagator as
  // the global propagator; its missing extract() made the middleware throw.
  propagation.disable();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
});
afterAll(() => {
  getTracer.mockRestore();
  if (prevEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevEndpoint;
});

describe('credentials in the request address', () => {
  it('a span names the route parameter, never the token', async () => {
    const app = new Hono();
    app.use('*', tracingMiddleware());
    app.get('/api/invitations/:token', (c) => c.json({ ok: true }));
    app.get('/api/settings/:key', (c) => c.json({ ok: true }));
    finished.length = 0;

    await app.request(`/api/invitations/${TOKEN}?magic_token=${TOKEN}&page=2`);
    await app.request('/api/settings/site_name');

    const spans = finished;
    expect(JSON.stringify(spans.map((s) => [s.name, s.attributes]))).not.toContain(TOKEN);
    expect(spans.map((s) => s.name)).toEqual([
      'GET /api/invitations/:token',
      'GET /api/settings/site_name',
    ]);
    expect(spans[0]!.attributes['http.route']).toBe('/api/invitations/:token');
    expect(spans[0]!.attributes['http.url']).toBe(
      'http://localhost/api/invitations/:token?magic_token=%5Bredacted%5D&page=2',
    );
  });

  it('the slow-request log keeps neither a path token nor a query token', async () => {
    const rows: Record<string, unknown>[] = [];
    const poolDb = {
      insertInto: () => ({
        values: (v: Record<string, unknown>) => {
          // query_params is `toJsonb(...)`: keep the text it binds.
          const node = (v.query_params as { toOperationNode(): unknown }).toOperationNode() as {
            parameters: { value: string }[];
          };
          rows.push({ ...v, query_params: JSON.parse(node.parameters[0]!.value) });
          return { execute: async () => undefined };
        },
      }),
    } as unknown as Database;
    const app = new Hono();
    app.use('*', slowQueryMiddleware(poolDb));
    const slow = async () => {
      await Bun.sleep(260);
      return new Response('ok');
    };
    app.get('/api/invitations/:token', slow);
    // better-auth answers /api/auth/* from one handler: no :token pattern to read.
    app.get('/api/auth/*', slow);

    await app.request(`/api/invitations/${TOKEN}`);
    await app.request(`/api/auth/reset-password/${TOKEN}?callbackURL=%2Fx`);
    await app.request(`/api/auth/verify-email?token=${TOKEN}&code=${TOKEN}`);
    for (let i = 0; i < 50 && rows.length < 3; i++) await Bun.sleep(10);

    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(rows.map((r) => r.path)).toEqual([
      '/api/invitations/:token',
      '/api/auth/reset-password/:token',
      '/api/auth/verify-email',
    ]);
    expect(rows[1]!.query_params).toEqual({ callbackURL: '/x' });
    expect(rows[2]!.query_params).toEqual({ token: '[redacted]', code: '[redacted]' });
  });
});

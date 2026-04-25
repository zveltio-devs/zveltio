import type { MiddlewareHandler } from 'hono';
import { propagation, context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// No-op when OTel is not configured — zero overhead in production without OTEL_EXPORTER_OTLP_ENDPOINT
const isEnabled = () => !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/**
 * HTTP server span middleware.
 * - Extracts W3C trace context (traceparent / tracestate) from incoming request headers
 * - Creates a SERVER span for the full request lifecycle
 * - Sets http.* attributes and final status code
 * - Injects trace context into response headers so downstream services can correlate
 */
export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isEnabled()) return next();

    // Extract W3C trace context from incoming headers
    const carrier: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { carrier[k] = v; });
    const parentCtx = propagation.extract(context.active(), carrier);

    const tracer = trace.getTracer('zveltio-engine');
    const spanName = `${c.req.method} ${c.req.path}`;

    return new Promise<void>((resolve, reject) => {
      tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.method':     c.req.method,
            'http.url':        c.req.url,
            'http.route':      c.req.path,
            'http.user_agent': c.req.header('user-agent') ?? '',
            'net.peer.ip':     c.req.header('x-forwarded-for') ?? '',
          },
        },
        parentCtx,
        async (span) => {
          // Inject current trace context into response so browsers/SDKs can read it
          const responseCarrier: Record<string, string> = {};
          propagation.inject(context.active(), responseCarrier);
          if (responseCarrier['traceparent']) {
            c.res.headers.set('traceparent', responseCarrier['traceparent']);
          }

          try {
            await next();
            const status = c.res.status;
            span.setAttribute('http.status_code', status);
            span.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
            span.end();
            resolve();
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
            span.end();
            reject(err);
          }
        },
      );
    });
  };
}

/**
 * Wraps an outgoing fetch call in a CLIENT span.
 * Use this instead of raw fetch() in webhooks, AI calls, edge function runner.
 */
export async function tracedFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isEnabled()) return fetch(url, init);

  const tracer = trace.getTracer('zveltio-engine');
  const method = (init?.method ?? 'GET').toUpperCase();
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();

  return tracer.startActiveSpan(
    `HTTP ${method} ${parsed?.hostname ?? url}`,
    { kind: SpanKind.CLIENT, attributes: { 'http.method': method, 'http.url': url } },
    async (span) => {
      // Inject trace context into outgoing request headers
      const headers = new Headers(init?.headers);
      const traceCarrier: Record<string, string> = {};
      propagation.inject(context.active(), traceCarrier);
      for (const [k, v] of Object.entries(traceCarrier)) headers.set(k, v);

      try {
        const res = await fetch(url, { ...init, headers });
        span.setAttribute('http.status_code', res.status);
        span.setStatus({ code: res.status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end();
        return res;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw err;
      }
    },
  );
}

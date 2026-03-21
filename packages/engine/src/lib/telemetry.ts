import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const TRACER_NAME = 'zveltio-engine';

/**
 * Returns a tracer. If OpenTelemetry is not configured, returns a no-op tracer.
 * Activate tracing by setting OTEL_EXPORTER_OTLP_ENDPOINT env var.
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Wraps an async operation in an OpenTelemetry span.
 */
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Initializes the OTel SDK. No-op if OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 * Call once at bootstrap before processing any requests.
 */
export async function initTelemetry(): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
      serviceName: process.env.OTEL_SERVICE_NAME || 'zveltio-engine',
    });

    sdk.start();
    console.log(`✅ OpenTelemetry initialized → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  } catch (err) {
    console.warn('⚠️ OpenTelemetry init failed (non-fatal):', err);
  }
}

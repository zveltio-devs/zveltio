import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// ── Prometheus-style counters for Zones / Views ───────────────────────────────

interface LabeledCounter {
  inc(labels: Record<string, string>): void;
  toPrometheusLines(name: string, help: string): string[];
}

function labeledCounter(): LabeledCounter {
  const data = new Map<string, number>();

  const keyOf = (labels: Record<string, string>) =>
    Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
      .join(',');

  return {
    inc(labels) {
      const key = keyOf(labels);
      data.set(key, (data.get(key) ?? 0) + 1);
    },
    toPrometheusLines(name, help) {
      if (data.size === 0) return [];
      const lines = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} counter`,
      ];
      for (const [labels, value] of data.entries()) {
        lines.push(`${name}{${labels}} ${value}`);
      }
      return lines;
    },
  };
}

interface LabeledHistogram {
  observe(labels: Record<string, string>, valueMs: number): void;
  toPrometheusLines(name: string, help: string): string[];
}

function labeledHistogram(buckets: number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000]): LabeledHistogram {
  type BucketData = { sum: number; count: number; buckets: Map<number, number> };
  const data = new Map<string, BucketData>();

  const keyOf = (labels: Record<string, string>) =>
    Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
      .join(',');

  return {
    observe(labels, valueMs) {
      const key = keyOf(labels);
      if (!data.has(key)) {
        data.set(key, { sum: 0, count: 0, buckets: new Map(buckets.map((b) => [b, 0])) });
      }
      const entry = data.get(key)!;
      entry.sum += valueMs;
      entry.count++;
      for (const b of buckets) {
        if (valueMs <= b) entry.buckets.set(b, (entry.buckets.get(b) ?? 0) + 1);
      }
    },
    toPrometheusLines(name, help) {
      if (data.size === 0) return [];
      const lines = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} histogram`,
      ];
      for (const [labels, entry] of data.entries()) {
        const labelStr = labels ? `{${labels},` : '{';
        for (const [b, count] of entry.buckets.entries()) {
          lines.push(`${name}_bucket${labelStr}le="${b}"} ${count}`);
        }
        lines.push(`${name}_bucket${labelStr}le="+Inf"} ${entry.count}`);
        lines.push(`${name}_sum{${labels}} ${entry.sum.toFixed(3)}`);
        lines.push(`${name}_count{${labels}} ${entry.count}`);
      }
      return lines;
    },
  };
}

/** Zone render request counter — labels: zone_slug, page_slug */
export const zoneRenderRequests = labeledCounter();

/** Zone access denied counter — labels: zone_slug, role */
export const zoneAccessDenied = labeledCounter();

/** View query duration histogram — labels: view_id, collection */
export const viewQueryDuration = labeledHistogram();

/**
 * Returns all zone/view Prometheus metric lines for inclusion in /metrics output.
 */
export function getZoneMetricsLines(): string[] {
  return [
    ...zoneRenderRequests.toPrometheusLines(
      'zone_render_requests_total',
      'Total zone render requests by zone and page slug',
    ),
    ...zoneAccessDenied.toPrometheusLines(
      'zone_access_denied_total',
      'Total zone access denied events by zone slug and user role',
    ),
    ...viewQueryDuration.toPrometheusLines(
      'view_query_duration_ms',
      'View data query duration in milliseconds',
    ),
  ];
}

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
    const { NodeSDK }           = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @opentelemetry/core is a transitive dep of sdk-node; types not declared directly
    const otelCore = await import('@opentelemetry/core');
    const { propagation } = await import('@opentelemetry/api');

    // Register W3C traceparent + baggage propagators.
    // CompositePropagator lives in @opentelemetry/core ≥1.x; fall back to W3C-only if absent.
    const W3CTraceCtx  = otelCore.W3CTraceContextPropagator;
    const W3CBaggage   = otelCore.W3CBaggagePropagator;
    const Composite    = (otelCore as any).CompositePropagator;

    if (Composite && W3CBaggage) {
      propagation.setGlobalPropagator(new Composite({ propagators: [new W3CTraceCtx(), new W3CBaggage()] }));
    } else {
      propagation.setGlobalPropagator(new W3CTraceCtx());
    }

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

/**
 * Wraps a Kysely execute() call with a database span.
 * Usage: await tracedQuery('users.list', () => db.selectFrom('users').selectAll().execute())
 */
export async function tracedQuery<T>(
  operationName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return fn();
  return traced(`db.query ${operationName}`, { 'db.system': 'postgresql', 'db.operation': operationName }, fn);
}

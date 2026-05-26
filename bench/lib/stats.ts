/**
 * Stats helpers — percentiles, mean, std-dev, throughput.
 *
 * Kept dependency-free so the benchmark runner stays small. The
 * percentile algorithm is "nearest-rank" (R-2), which is what most
 * load-testing tools (wrk, k6, hey) report — easier to reproduce
 * across runs than interpolated quantiles.
 */

/** Compute percentile of a numeric array. Returns NaN on empty input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (p < 0 || p > 100) throw new Error(`percentile out of range: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(p/100 * N); index = rank - 1
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export interface SampleStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
  /** Operations per second derived from `total wall-clock duration` (ms). */
  throughput?: number;
}

export function summarize(samples: readonly number[], durationMs?: number): SampleStats {
  if (samples.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      stddev: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
    };
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;
  const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / samples.length;
  const stddev = Math.sqrt(variance);
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean,
    stddev,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    throughput: durationMs && durationMs > 0 ? (samples.length * 1000) / durationMs : undefined,
  };
}

/**
 * Pretty-print a stats row, e.g. for CLI output.
 * Numbers in milliseconds.
 */
export function formatStats(label: string, s: SampleStats): string {
  const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const cols = [
    label.padEnd(28),
    `n=${s.count}`.padEnd(9),
    `min ${fmt(s.min, 2)}ms`.padEnd(14),
    `p50 ${fmt(s.p50, 2)}ms`.padEnd(14),
    `p95 ${fmt(s.p95, 2)}ms`.padEnd(14),
    `p99 ${fmt(s.p99, 2)}ms`.padEnd(14),
    `mean ${fmt(s.mean, 2)}±${fmt(s.stddev, 2)}ms`.padEnd(22),
    s.throughput != null ? `${fmt(s.throughput, 0)} ops/s` : '',
  ];
  return cols.join(' ').trimEnd();
}

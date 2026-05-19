/**
 * Shared benchmark config. Reads env vars with sensible defaults so a fresh
 * `bun run bench/runner.ts` works against `localhost:3000` with the default
 * dev credentials documented in bench/README.md.
 */

export interface BenchConfig {
  baseUrl: string;
  email: string;
  password: string;
  /** Number of warmup iterations (excluded from stats). */
  warmup: number;
  /** Number of measured iterations per benchmark. */
  iterations: number;
  /** Outbound concurrency for parallel workloads. */
  concurrency: number;
  /** Where to write the JSON results. */
  outputPath: string;
}

export function loadConfig(): BenchConfig {
  return {
    baseUrl: process.env.BENCH_BASE_URL ?? 'http://localhost:3000',
    email: process.env.BENCH_EMAIL ?? 'admin@example.com',
    password: process.env.BENCH_PASSWORD ?? 'admin1234',
    warmup: Number(process.env.BENCH_WARMUP ?? 20),
    iterations: Number(process.env.BENCH_ITERATIONS ?? 200),
    concurrency: Number(process.env.BENCH_CONCURRENCY ?? 1),
    outputPath: process.env.BENCH_OUTPUT ?? 'bench/results/latest.json',
  };
}

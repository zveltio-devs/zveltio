/**
 * Unit tests for the percentile + summarize helpers.
 *
 * The bench output is only as trustworthy as its math. Lock down the
 * algorithm with a few known-answer cases so a refactor doesn't silently
 * swap nearest-rank for interpolated quantiles or vice versa.
 */

import { describe, it, expect } from 'bun:test';
import { percentile, summarize } from './stats.js';

describe('percentile (nearest-rank R-2)', () => {
  it('returns NaN on empty input', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('returns the single value for any percentile when n=1', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('computes p50/p95/p99 on a 100-element ramp', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile(xs, 100)).toBe(100);
  });

  it('is order-independent', () => {
    const a = [3, 1, 4, 1, 5, 9, 2, 6];
    const b = [...a].reverse();
    expect(percentile(a, 50)).toBe(percentile(b, 50));
  });

  it('throws on out-of-range p', () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow();
    expect(() => percentile([1, 2, 3], 101)).toThrow();
  });
});

describe('summarize', () => {
  it('zero-count returns NaNs and no throughput', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.mean).toBeNaN();
    expect(s.throughput).toBeUndefined();
  });

  it('computes mean / stddev / count', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    // population stddev of 1..5 = sqrt(2) ≈ 1.4142
    expect(s.stddev).toBeCloseTo(Math.sqrt(2), 4);
  });

  it('throughput = count * 1000 / durationMs', () => {
    const s = summarize([1, 1, 1, 1], 2000);
    expect(s.throughput).toBeCloseTo(2, 6); // 4 ops in 2s = 2 ops/s
  });
});

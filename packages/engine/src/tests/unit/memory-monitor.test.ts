/**
 * Unit coverage for runtime/memory-monitor.ts — process memory sampling +
 * reporting. Pure functions over process.memoryUsage(); no DB or network.
 *
 * The efficiency-threshold + MB-conversion branches are driven by stubbing
 * process.memoryUsage() with controlled byte counts, restored after each test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  checkMemoryThreshold,
  forceGC,
  getMemoryReport,
  getMemoryUsage,
  getPeakStats,
  resetMemoryStats,
  startMemorySampling,
  stopMemorySampling,
  updatePeakStats,
} from '../../lib/runtime/memory-monitor.js';

const MB = 1024 * 1024;
let originalMemoryUsage: typeof process.memoryUsage;

function stubUsage(heapUsedMB: number, heapTotalMB: number, rssMB = heapTotalMB): void {
  process.memoryUsage = (() => ({
    heapUsed: heapUsedMB * MB,
    heapTotal: heapTotalMB * MB,
    rss: rssMB * MB,
    external: 0,
    arrayBuffers: 0,
  })) as unknown as typeof process.memoryUsage;
}

beforeEach(() => {
  originalMemoryUsage = process.memoryUsage;
  resetMemoryStats();
});
afterEach(() => {
  process.memoryUsage = originalMemoryUsage;
  stopMemorySampling();
});

describe('getMemoryUsage', () => {
  it('converts bytes to rounded MB', () => {
    stubUsage(50, 100, 150);
    const u = getMemoryUsage();
    expect(u.heapUsedMB).toBe(50);
    expect(u.heapTotalMB).toBe(100);
    expect(u.rssMB).toBe(150);
    expect(u.heapUsed).toBe(50 * MB);
  });
});

describe('peak stats', () => {
  it('tracks the maximum across samples and counts them', () => {
    stubUsage(100, 200);
    updatePeakStats();
    stubUsage(60, 120); // lower — peaks must not drop
    updatePeakStats();
    const peak = getPeakStats();
    expect(peak.peakHeapUsed).toBe(100 * MB);
    expect(peak.peakHeapTotal).toBe(200 * MB);
    expect(peak.samples).toBe(2);
  });

  it('resetMemoryStats zeroes everything', () => {
    stubUsage(10, 20);
    updatePeakStats();
    resetMemoryStats();
    expect(getPeakStats()).toEqual({
      peakHeapUsed: 0,
      peakHeapTotal: 0,
      peakRSS: 0,
      samples: 0,
    });
  });
});

describe('getMemoryReport efficiency thresholds', () => {
  it('reports Good below 80% heap usage', () => {
    stubUsage(50, 100);
    expect(getMemoryReport().efficiency).toEqual({
      heapUsagePercent: 50,
      heapEfficiency: 'Good',
    });
  });

  it('reports Warning between 80% and 90%', () => {
    stubUsage(85, 100);
    const eff = getMemoryReport().efficiency;
    expect(eff.heapUsagePercent).toBe(85);
    expect(eff.heapEfficiency).toMatch(/Warning/);
  });

  it('reports Critical above 90% (regression: was unreachable)', () => {
    stubUsage(95, 100);
    const eff = getMemoryReport().efficiency;
    expect(eff.heapUsagePercent).toBe(95);
    expect(eff.heapEfficiency).toMatch(/Critical/);
  });
});

describe('sampling', () => {
  it('samples on an interval and stops cleanly', async () => {
    stubUsage(10, 20);
    startMemorySampling(10);
    await new Promise((r) => setTimeout(r, 35));
    stopMemorySampling();
    const after = getPeakStats().samples;
    expect(after).toBeGreaterThanOrEqual(1);

    // No further samples after stop.
    await new Promise((r) => setTimeout(r, 25));
    expect(getPeakStats().samples).toBe(after);
  });

  it('restarts cleanly when called twice (no duplicate timers)', async () => {
    stubUsage(10, 20);
    startMemorySampling(10);
    startMemorySampling(10); // replaces the first timer
    await new Promise((r) => setTimeout(r, 35));
    stopMemorySampling();
    expect(getPeakStats().samples).toBeGreaterThanOrEqual(1);
  });
});

describe('misc', () => {
  it('checkMemoryThreshold warns only above the threshold', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.join(' '));
    try {
      stubUsage(2000, 4000);
      checkMemoryThreshold(1024); // 2000MB > 1024 → warn
      stubUsage(100, 400);
      checkMemoryThreshold(1024); // 100MB < 1024 → no warn
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/exceeded 1024MB/);
  });

  it('forceGC returns true when global.gc is available', () => {
    const g = globalThis as typeof globalThis & { gc?: () => void };
    const original = g.gc;
    let called = false;
    g.gc = (async () => {
      called = true;
    }) as typeof g.gc;
    try {
      expect(forceGC()).toBe(true);
      expect(called).toBe(true);
    } finally {
      g.gc = original;
    }
  });

  it('logs heap usage during development sampling', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));
    try {
      stubUsage(12, 24);
      startMemorySampling(10);
      await new Promise((r) => setTimeout(r, 35));
      stopMemorySampling();
      expect(logs.some((l) => l.includes('[Memory Monitor]'))).toBe(true);
    } finally {
      console.log = orig;
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });
});

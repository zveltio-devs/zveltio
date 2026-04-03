/**
 * Memory monitoring utilities for Zveltio Engine
 * Provides memory usage tracking and reporting to help identify memory leaks
 * and optimize resource consumption.
 */

let memoryStats: {
  peakHeapUsed: number;
  peakHeapTotal: number;
  peakRSS: number;
  samples: number;
} = {
  peakHeapUsed: 0,
  peakHeapTotal: 0,
  peakRSS: 0,
  samples: 0,
};

const MEMORY_SAMPLING_INTERVAL = 60_000; // Sample every minute
let samplingInterval: NodeJS.Timeout | null = null;

/**
 * Get current memory usage statistics
 */
export function getMemoryUsage(): {
  heapUsed: number;
  heapTotal: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rss: number;
  rssMB: number;
  external: number;
  arrayBuffers: number;
} {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
    rss: usage.rss,
    rssMB: Math.round(usage.rss / 1024 / 1024),
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

/**
 * Update peak memory statistics
 */
export function updatePeakStats(): void {
  const usage = process.memoryUsage();
  memoryStats.peakHeapUsed = Math.max(memoryStats.peakHeapUsed, usage.heapUsed);
  memoryStats.peakHeapTotal = Math.max(
    memoryStats.peakHeapTotal,
    usage.heapTotal,
  );
  memoryStats.peakRSS = Math.max(memoryStats.peakRSS, usage.rss);
  memoryStats.samples++;
}

/**
 * Get peak memory statistics
 */
export function getPeakStats(): typeof memoryStats {
  return { ...memoryStats };
}

/**
 * Reset memory statistics
 */
export function resetMemoryStats(): void {
  memoryStats = {
    peakHeapUsed: 0,
    peakHeapTotal: 0,
    peakRSS: 0,
    samples: 0,
  };
}

/**
 * Start automatic memory sampling
 */
export function startMemorySampling(
  intervalMs = MEMORY_SAMPLING_INTERVAL,
): void {
  if (samplingInterval) {
    stopMemorySampling();
  }

  samplingInterval = setInterval(() => {
    updatePeakStats();

    // Log memory usage in development
    if (process.env.NODE_ENV === 'development') {
      const usage = getMemoryUsage();
      console.log(
        `[Memory Monitor] Heap: ${usage.heapUsedMB}MB/${usage.heapTotalMB}MB | RSS: ${usage.rssMB}MB | Samples: ${memoryStats.samples}`,
      );
    }
  }, intervalMs);
}

/**
 * Stop automatic memory sampling
 */
export function stopMemorySampling(): void {
  if (samplingInterval) {
    clearInterval(samplingInterval);
    samplingInterval = null;
  }
}

/**
 * Get detailed memory report
 */
export function getMemoryReport(): {
  current: ReturnType<typeof getMemoryUsage>;
  peak: typeof memoryStats;
  efficiency: {
    heapUsagePercent: number;
    heapEfficiency: string;
  };
} {
  const current = getMemoryUsage();
  const peak = getPeakStats();
  const heapUsagePercent = Math.round(
    (current.heapUsed / current.heapTotal) * 100,
  );

  let heapEfficiency = 'Good';
  if (heapUsagePercent > 80) {
    heapEfficiency = 'Warning: High heap usage';
  } else if (heapUsagePercent > 90) {
    heapEfficiency = 'Critical: Near heap limit';
  }

  return {
    current,
    peak,
    efficiency: {
      heapUsagePercent,
      heapEfficiency,
    },
  };
}

/**
 * Force garbage collection if available (only in development)
 * Note: This requires Node.js to be started with --expose-gc flag
 */
export function forceGC(): boolean {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Log memory warning if usage exceeds threshold
 */
export function checkMemoryThreshold(thresholdMB = 1024): void {
  const usage = getMemoryUsage();
  if (usage.heapUsedMB > thresholdMB) {
    console.warn(
      `[Memory Warning] Heap usage exceeded ${thresholdMB}MB: ${usage.heapUsedMB}MB/${usage.heapTotalMB}MB`,
    );
  }
}

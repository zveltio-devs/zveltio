/// <reference types="bun-types" />
/**
 * PDF Queue — pool of up to 4 Bun Workers for off-thread PDF generation.
 * Queues requests when all workers are busy.
 */

const WORKER_URL = new URL('../workers/pdf-worker.ts', import.meta.url);
const MAX_WORKERS = 4;

/**
 * How long one render may take before the worker is given up on.
 *
 * There was no limit. A worker that accepted the job and never answered — a
 * chromium render that wedges — left the promise pending forever AND its pool
 * slot marked busy forever. Measured: four such renders fill the pool, every
 * later request queues behind them, and the PDF feature is dead for the life of
 * the process while each HTTP request waits with it. The existing suites could
 * not see it: they replace `Worker` with one that always answers.
 *
 * A wedged render is also why the worker is terminated rather than reused: it
 * may still be holding the page it hung on.
 */
let renderTimeoutMs = 60_000;

interface PendingRequest {
  html: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  options: Record<string, any>;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  currentResolve?: (buf: Buffer) => void;
  currentReject?: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pool: PooledWorker[] = [];
const queue: PendingRequest[] = [];

/** Clear the in-flight state of a worker and return the settlers it held. */
function takeSettlers(pw: PooledWorker): {
  resolve?: (buf: Buffer) => void;
  reject?: (err: Error) => void;
} {
  const { currentResolve: resolve, currentReject: reject } = pw;
  if (pw.timer) clearTimeout(pw.timer);
  pw.timer = undefined;
  pw.busy = false;
  pw.currentResolve = undefined;
  pw.currentReject = undefined;
  return { resolve, reject };
}

/** Drop a worker from the pool for good — it is wedged or dead. */
function discardWorker(pw: PooledWorker): void {
  const i = pool.indexOf(pw);
  if (i >= 0) pool.splice(i, 1);
  try {
    pw.worker.terminate();
  } catch {
    /* already gone */
  }
}

function createWorker(): PooledWorker {
  const pw: PooledWorker = {
    worker: new Worker(WORKER_URL),
    busy: false,
  };

  pw.worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { type: string; buffer?: ArrayBuffer; message?: string };
    const { resolve, reject } = takeSettlers(pw);

    if (msg.type === 'result' && msg.buffer) {
      resolve?.(Buffer.from(msg.buffer));
    } else {
      reject?.(new Error(msg.message ?? 'PDF generation failed'));
    }

    processQueue();
  };

  pw.worker.onerror = (err: ErrorEvent) => {
    const { reject } = takeSettlers(pw);
    // A worker that raised a fatal error used to stay in the pool, not busy, and
    // the next job was posted into it — another request with nobody to answer it.
    discardWorker(pw);
    reject?.(new Error(err.message ?? 'PDF worker error'));
    processQueue();
  };

  return pw;
}

function assignToWorker(pw: PooledWorker, req: PendingRequest): void {
  pw.busy = true;
  pw.currentResolve = req.resolve;
  pw.currentReject = req.reject;
  pw.timer = setTimeout(() => {
    const { reject } = takeSettlers(pw);
    discardWorker(pw);
    reject?.(new Error(`PDF generation timed out after ${renderTimeoutMs} ms`));
    processQueue();
  }, renderTimeoutMs);
  pw.worker.postMessage({ type: 'generate', html: req.html, options: req.options });
}

/** A free worker, creating one if the pool has room. */
function acquireWorker(): PooledWorker | undefined {
  const free = pool.find((pw) => !pw.busy);
  if (free) return free;
  if (pool.length >= MAX_WORKERS) return undefined;
  const created = createWorker();
  pool.push(created);
  return created;
}

function processQueue(): void {
  // Loops because a discarded worker leaves room for a NEW one: with a plain
  // `pool.find` a queue drained only when an existing worker reported back, so a
  // timeout that removed the last worker left the queue stranded.
  while (queue.length > 0) {
    const worker = acquireWorker();
    if (!worker) return;
    assignToWorker(worker, queue.shift()!);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function generatePDFAsync(html: string, options: Record<string, any> = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const freeWorker = acquireWorker();
    if (freeWorker) {
      assignToWorker(freeWorker, { html, options, resolve, reject });
    } else {
      queue.push({ html, options, resolve, reject });
    }
  });
}

process.on('beforeExit', () => {
  for (const pw of pool) {
    pw.worker.terminate();
  }
});

/** Test-only — 60 s is correct in production and far too long for a suite. */
export function _setRenderTimeoutForTests(ms: number): () => void {
  const previous = renderTimeoutMs;
  renderTimeoutMs = ms;
  return () => {
    renderTimeoutMs = previous;
  };
}

/** Test-only — clears the worker pool between unit tests. */
export function _resetPdfQueueForTests(): void {
  for (const pw of pool) {
    if (pw.timer) clearTimeout(pw.timer);
    try {
      pw.worker.terminate();
    } catch {
      /* */
    }
  }
  pool.length = 0;
  queue.length = 0;
}

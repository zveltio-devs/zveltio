/// <reference types="bun-types" />
/**
 * PDF Queue — pool of up to 4 Bun Workers for off-thread PDF generation.
 * Queues requests when all workers are busy.
 */

const WORKER_URL = new URL('../workers/pdf-worker.ts', import.meta.url);
const MAX_WORKERS = 4;

interface PendingRequest {
  html: string;
  options: Record<string, any>;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  currentResolve?: (buf: Buffer) => void;
  currentReject?: (err: Error) => void;
}

const pool: PooledWorker[] = [];
const queue: PendingRequest[] = [];

function createWorker(): PooledWorker {
  const pw: PooledWorker = {
    worker: new Worker(WORKER_URL),
    busy: false,
  };

  pw.worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { type: string; buffer?: ArrayBuffer; message?: string };
    const { currentResolve, currentReject } = pw;

    pw.busy = false;
    pw.currentResolve = undefined;
    pw.currentReject = undefined;

    if (msg.type === 'result' && msg.buffer) {
      currentResolve?.(Buffer.from(msg.buffer));
    } else {
      currentReject?.(new Error(msg.message ?? 'PDF generation failed'));
    }

    processQueue();
  };

  pw.worker.onerror = (err: ErrorEvent) => {
    const { currentReject } = pw;
    pw.busy = false;
    pw.currentResolve = undefined;
    pw.currentReject = undefined;
    currentReject?.(new Error(err.message ?? 'PDF worker error'));
    processQueue();
  };

  return pw;
}

function assignToWorker(pw: PooledWorker, req: PendingRequest): void {
  pw.busy = true;
  pw.currentResolve = req.resolve;
  pw.currentReject = req.reject;
  pw.worker.postMessage({ type: 'generate', html: req.html, options: req.options });
}

function processQueue(): void {
  if (queue.length === 0) return;
  const freeWorker = pool.find((pw) => !pw.busy);
  if (!freeWorker) return;
  const next = queue.shift()!;
  assignToWorker(freeWorker, next);
}

export function generatePDFAsync(html: string, options: Record<string, any> = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let freeWorker = pool.find((pw) => !pw.busy);

    if (!freeWorker && pool.length < MAX_WORKERS) {
      freeWorker = createWorker();
      pool.push(freeWorker);
    }

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

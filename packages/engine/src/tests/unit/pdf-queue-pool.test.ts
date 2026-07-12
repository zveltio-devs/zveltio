/**
 * pdf-queue.ts — worker pool saturation, queue drain, beforeExit cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _resetPdfQueueForTests, generatePDFAsync } from '../../lib/pdf-queue.js';

const OriginalWorker = globalThis.Worker;
const MAX_WORKERS = 4;

let releaseFns: Array<() => void> = [];
let workerCount = 0;

beforeEach(() => {
  releaseFns = [];
  workerCount = 0;
  _resetPdfQueueForTests();
  globalThis.Worker = class BusyWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    constructor(_url: URL | string) {
      workerCount++;
    }
    postMessage(_msg: unknown) {
      releaseFns.push(() => {
        this.onmessage?.({
          data: { type: 'result', buffer: Uint8Array.from([0x25, 0x50, 0x44, 0x46]).buffer },
        } as MessageEvent);
      });
    }
    terminate() {}
  } as unknown as typeof Worker;
});

afterEach(() => {
  _resetPdfQueueForTests();
  globalThis.Worker = OriginalWorker;
});

describe('generatePDFAsync — pool + queue', () => {
  it('queues work when all workers are busy and drains when one frees up', async () => {
    const pending = Array.from({ length: MAX_WORKERS + 1 }, (_, i) =>
      generatePDFAsync(`<html>doc-${i}</html>`),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(workerCount).toBe(MAX_WORKERS);

    let completed = 0;
    while (completed < MAX_WORKERS + 1) {
      const fn = releaseFns.shift();
      if (fn) {
        fn();
        completed++;
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    const bufs = await Promise.all(pending);
    expect(bufs).toHaveLength(MAX_WORKERS + 1);
    expect(bufs.every((b) => Buffer.isBuffer(b))).toBe(true);
  }, 10_000);

  it('terminates workers on process beforeExit', async () => {
    let terminated = 0;
    _resetPdfQueueForTests();
    globalThis.Worker = class ExitWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(_url: URL | string) {}
      postMessage(_msg: unknown) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: 'result', buffer: Uint8Array.from([1]).buffer },
          } as MessageEvent);
        });
      }
      terminate() {
        terminated++;
      }
    } as unknown as typeof Worker;

    await generatePDFAsync('<html>x</html>');
    process.emit('beforeExit', 0);
    expect(terminated).toBeGreaterThanOrEqual(1);
  });
});

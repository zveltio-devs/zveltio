/**
 * PDF worker pool (lib/pdf-queue.ts) — off-thread generation via mocked Workers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _resetPdfQueueForTests, generatePDFAsync } from '../../lib/pdf-queue.js';

const OriginalWorker = globalThis.Worker;
let posted: unknown[] = [];

function installSuccessWorker(): void {
  globalThis.Worker = class MockPdfWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    constructor(_url: URL | string) {}
    postMessage(msg: unknown) {
      posted.push(msg);
      queueMicrotask(() => {
        this.onmessage?.({
          data: { type: 'result', buffer: Uint8Array.from([0x25, 0x50, 0x44, 0x46]).buffer },
        } as MessageEvent);
      });
    }
    terminate() {}
  } as unknown as typeof Worker;
}

beforeEach(() => {
  posted = [];
  _resetPdfQueueForTests();
  installSuccessWorker();
});

afterEach(() => {
  _resetPdfQueueForTests();
  globalThis.Worker = OriginalWorker;
});

describe('generatePDFAsync', () => {
  it('resolves with a Buffer when the worker returns a result', async () => {
    const buf = await generatePDFAsync('<html><body>PDF</body></html>', { format: 'A4' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects when the worker posts an error result', async () => {
    _resetPdfQueueForTests();
    globalThis.Worker = class ErrorWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(_url: URL | string) {}
      postMessage(_msg: unknown) {
        queueMicrotask(() => {
          this.onmessage?.({ data: { type: 'error', message: 'render failed' } } as MessageEvent);
        });
      }
      terminate() {}
    } as unknown as typeof Worker;

    await expect(generatePDFAsync('<html></html>')).rejects.toThrow(/render failed/);
  });

  it('rejects when the worker fires onerror', async () => {
    _resetPdfQueueForTests();
    globalThis.Worker = class CrashWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(_url: URL | string) {}
      postMessage(_msg: unknown) {
        queueMicrotask(() => {
          this.onerror?.({ message: 'worker crashed' } as ErrorEvent);
        });
      }
      terminate() {}
    } as unknown as typeof Worker;

    await expect(generatePDFAsync('<html></html>')).rejects.toThrow(/worker crashed|PDF worker error/);
  });
});

/**
 * A worker that accepts a render and never answers used to hang the caller
 * forever AND keep its pool slot marked busy forever. Four of those and the PDF
 * feature is dead for the life of the process, with every HTTP request that
 * asked for a PDF still waiting.
 *
 * Nothing could have caught it: `pdf-queue.test.ts` and `pdf-queue-pool.test.ts`
 * both replace `Worker` with one that always answers, so the only shape under
 * test was the cooperative one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  _resetPdfQueueForTests,
  _setRenderTimeoutForTests,
  generatePDFAsync,
} from '../../lib/pdf-queue.js';

const OriginalWorker = globalThis.Worker;
let restoreTimeout: (() => void) | null = null;
let created = 0;

/** Accepts the job, never replies — a wedged chromium render. */
class DeafWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(_url: URL | string) {
    created++;
  }
  postMessage(_msg: unknown) {}
  terminate() {}
}

beforeEach(() => {
  created = 0;
  _resetPdfQueueForTests();
  restoreTimeout = _setRenderTimeoutForTests(150);
  globalThis.Worker = DeafWorker as unknown as typeof Worker;
});

afterEach(() => {
  restoreTimeout?.();
  restoreTimeout = null;
  _resetPdfQueueForTests();
  globalThis.Worker = OriginalWorker;
});

describe('pdf-queue — a worker that never answers', () => {
  it('rejects rather than hanging the caller forever', async () => {
    await expect(generatePDFAsync('<html>x</html>')).rejects.toThrow(/timed out/);
  });

  it('gives the slot back, so a later request is not queued behind the wedge', async () => {
    // Saturate the pool with four renders that will never answer.
    const wedged = Array.from({ length: 4 }, (_, i) =>
      generatePDFAsync(`<html>${i}</html>`).catch((e: Error) => e.message),
    );
    // A fifth request has nowhere to go and waits in the queue.
    const queued = generatePDFAsync('<html>queued</html>').catch((e: Error) => e.message);

    const results = await Promise.all([...wedged, queued]);
    // Every one settles — the queued one included, which is the part that was
    // stranded: its worker had been discarded, and the drain only ran when an
    // EXISTING worker reported back.
    expect(results.every((r) => /timed out/.test(String(r)))).toBe(true);
    expect(created).toBeGreaterThan(4); // the wedged ones were replaced, not reused
  }, 10_000);

  it('a worker that raises a fatal error is dropped from the pool', async () => {
    // An array rather than a `let`: TypeScript narrows a variable assigned
    // only inside a class body to its initialiser type at the call below.
    const raisers: Array<() => void> = [];
    globalThis.Worker = class ExplodingWorker extends DeafWorker {
      postMessage(_msg: unknown) {
        raisers.push(() => this.onerror?.({ message: 'worker died' } as ErrorEvent));
      }
    } as unknown as typeof Worker;

    const p = generatePDFAsync('<html>x</html>').catch((e: Error) => e.message);
    await Bun.sleep(0);
    raisers[0]?.();
    expect(await p).toBe('worker died');
    // The dead one is gone: the next call builds a new worker rather than
    // posting into a corpse.
    const before = created;
    void generatePDFAsync('<html>y</html>').catch(() => {});
    expect(created).toBe(before + 1);
  });
});

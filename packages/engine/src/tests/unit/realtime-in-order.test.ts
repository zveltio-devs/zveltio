/**
 * `inOrder` (lib/data/read-scope.ts): realtime delivery behind async verdicts.
 *
 * A verdict that rejected while an earlier one for the same subscriber was
 * still pending had no handler until the queue reached it — an unhandled
 * rejection, which the engine's `unhandledRejection` handler answers with
 * `process.exit(1)`. One entity check that throws, behind one that is slow,
 * took the whole engine down.
 */
import { afterEach, expect, it } from 'bun:test';
import { inOrder } from '../../lib/data/read-scope.js';

const seen: unknown[] = [];
const listener = (reason: unknown) => seen.push(reason);
afterEach(() => {
  process.off('unhandledRejection', listener);
  seen.length = 0;
});

it('a verdict that rejects behind a pending one is dropped, never unhandled', async () => {
  process.on('unhandledRejection', listener);
  const queue: { pending?: Promise<void> } = {};
  const sent: string[] = [];
  let release!: (ok: boolean) => void;
  inOrder(queue, new Promise<boolean>((r) => (release = r)), () => sent.push('first'));
  inOrder(queue, Promise.reject(new Error('entity check threw')), () => sent.push('thrown'));
  inOrder(queue, true, () => sent.push('second'));
  await Bun.sleep(20); // the rejection settles while `first` is still pending
  release(true);
  await Bun.sleep(20);
  expect(seen).toEqual([]);
  expect(sent).toEqual(['first', 'second']);
  expect(queue.pending).toBeUndefined();
});

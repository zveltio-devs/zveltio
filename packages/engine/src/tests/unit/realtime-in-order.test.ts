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

it('a send that throws behind a pending verdict is not an unhandled rejection', async () => {
  // Writing to a socket that closed meanwhile throws; on the queued path that
  // throw lands in a promise chain, where it would take the engine down.
  process.on('unhandledRejection', listener);
  const queue: { pending?: Promise<void> } = {};
  let release!: (ok: boolean) => void;
  inOrder(queue, new Promise<boolean>((r) => (release = r)), () => {
    throw new Error('socket closed');
  });
  release(true);
  await Bun.sleep(20);
  expect(seen).toEqual([]);
});

it('an earlier verdict settling does not let a later one jump the queue', async () => {
  const queue: { pending?: Promise<void> } = {};
  const sent: string[] = [];
  let releaseA!: (ok: boolean) => void;
  let releaseB!: (ok: boolean) => void;
  inOrder(queue, new Promise<boolean>((r) => (releaseA = r)), () => sent.push('a'));
  inOrder(queue, new Promise<boolean>((r) => (releaseB = r)), () => sent.push('b'));
  releaseA(true);
  await Bun.sleep(10); // `a` is done, `b` still pending
  inOrder(queue, true, () => sent.push('c'));
  releaseB(true);
  await Bun.sleep(10);
  expect(sent).toEqual(['a', 'b', 'c']);
});

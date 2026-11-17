/**
 * Which inline action held the event loop (ADR 0056 d2).
 *
 * A first-party action runs inline, on the engine's own thread. A loop that
 * never yields cannot be stopped from that thread, and nothing on it can log
 * while it spins. So the watchdog is a second thread: the main thread stamps a
 * heartbeat into shared memory and tells the watchdog which inline actions are
 * running; the watchdog, whose loop the stall does not touch, writes the log
 * line. After the orchestrator restarts the engine, the last lines name the
 * action.
 *
 * Started on the first inline action, so an engine that runs none pays for no
 * thread (about 9 MB on Bun 1.4).
 */

const BEAT_MS = 250;
/** A stall this long is logged; each further `REPEAT_MS` of it logs again. */
export const STALL_MS = 2_000;
const REPEAT_MS = 10_000;

// The watchdog's source travels as a Blob so it works from the compiled binary,
// which has no module file to point a Worker at.
const WATCHDOG = `
let beat; const running = new Map(); let next = 0;
self.onmessage = ({ data }) => {
  if (data.beat) beat = new BigInt64Array(data.beat);
  else if (data.start) running.set(data.id, data.start);
  else running.delete(data.id);
};
setInterval(() => {
  if (!beat) return;
  const age = Date.now() - Number(Atomics.load(beat, 0));
  if (age < ${STALL_MS}) { next = ${STALL_MS}; return; }
  if (age < next) return;
  next = age + ${REPEAT_MS};
  console.error(JSON.stringify({
    level: 'error', msg: 'event loop blocked', blockedMs: age,
    inlineActions: [...running.values()],
  }));
}, ${BEAT_MS});
`;

let worker: Worker | undefined;
let seq = 0;

function watchdog(): Worker {
  if (worker) return worker;
  const beat = new BigInt64Array(new SharedArrayBuffer(8));
  const stamp = () => Atomics.store(beat, 0, BigInt(Date.now()));
  stamp();
  worker = new Worker(URL.createObjectURL(new Blob([WATCHDOG])));
  worker.postMessage({ beat: beat.buffer });
  // Bun's Worker has `unref`; the DOM typing it is checked against does not.
  (worker as unknown as { unref(): void }).unref();
  setInterval(stamp, BEAT_MS).unref();
  return worker;
}

/** Run an inline action with its name on the watchdog's list. */
export async function attributed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const w = watchdog();
  const id = ++seq;
  w.postMessage({ id, start: label });
  try {
    return await run();
  } finally {
    w.postMessage({ id });
  }
}

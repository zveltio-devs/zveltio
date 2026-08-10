/**
 * `emitAsync` — the difference between a listener that runs and one that appears to.
 *
 * `emit` is EventEmitter's synchronous fan-out. An `async` listener returns a
 * promise at its first `await` and the emitter drops it on the floor, so the rest
 * of the listener runs after the request has finished and its transaction has
 * closed. Every such listener failed on "Transaction is already committed",
 * inside its own try/catch, which means the symptom was not an error anywhere:
 * the side effect simply never happened.
 *
 * e-Factura had never drafted an invoice on any installation. `operations/traceability`
 * had never built a chain link. Both looked healthy.
 *
 * The savepoint-per-listener path needs a live transaction and is exercised by
 * the harness lane; what is pinned here is the part that made those extensions
 * silently dead — that `emitAsync` actually waits.
 */

import { describe, expect, it } from 'bun:test';
import { engineEvents } from '../../lib/runtime/index.js';

const EVENT = 'record.created' as const;

/** A payload shaped like the real one; the bus does not inspect it here. */
const payload = {
  collection: 'zvd_invoices',
  record: { id: 'r1' },
  id: 'r1',
  userId: 'u1',
} as never;

describe('engineEvents.emitAsync', () => {
  it('resolves quietly when nothing is listening', async () => {
    await expect(engineEvents.emitAsync(EVENT, payload)).resolves.toBeUndefined();
  });

  it('waits for the whole listener, not just its first await', async () => {
    // The bug in one assertion. With `emit`, `done` is still false here, because
    // the listener resumed after the caller had moved on — and in a request, after
    // the transaction it was writing to had closed.
    let done = false;
    const off = engineEvents.on(EVENT, async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    try {
      await engineEvents.emitAsync(EVENT, payload);
      expect(done).toBe(true);
    } finally {
      off();
    }
  });

  it('runs every listener in registration order', async () => {
    const seen: string[] = [];
    const offs = [
      engineEvents.on(EVENT, async () => {
        await new Promise((r) => setTimeout(r, 8));
        seen.push('first');
      }),
      engineEvents.on(EVENT, async () => {
        seen.push('second');
      }),
    ];
    try {
      await engineEvents.emitAsync(EVENT, payload);
      // Sequential, not Promise.all: a savepoint per listener only works if the
      // listeners take their turn on the connection one at a time.
      expect(seen).toEqual(['first', 'second']);
    } finally {
      for (const off of offs) off();
    }
  });

  it('does not let one failing listener take out the write that triggered it', async () => {
    // An extension's listener is not allowed to fail the request. Before this,
    // an invoice was returned to the client with its number and then vanished,
    // because a listener's error rolled the caller's own transaction back.
    const seen: string[] = [];
    const offs = [
      engineEvents.on(EVENT, async () => {
        throw new Error('listener blew up');
      }),
      engineEvents.on(EVENT, async () => {
        seen.push('still ran');
      }),
    ];
    try {
      await expect(engineEvents.emitAsync(EVENT, payload)).resolves.toBeUndefined();
      expect(seen).toEqual(['still ran']);
    } finally {
      for (const off of offs) off();
    }
  });

  it('survives a listener that throws synchronously', async () => {
    const offs = [
      engineEvents.on(EVENT, () => {
        throw new Error('sync blow-up');
      }),
    ];
    try {
      await expect(engineEvents.emitAsync(EVENT, payload)).resolves.toBeUndefined();
    } finally {
      for (const off of offs) off();
    }
  });
});

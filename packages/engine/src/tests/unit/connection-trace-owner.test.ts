/**
 * The traced window charges a request only what its own context takes.
 *
 * The window is process-wide. In CI a webhook delivery left behind by an earlier
 * test recorded its outcome on the pool while a data write held the window, and
 * the write was reported as taking a second connection (`write-path-one-connection`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  _setConnectionTracing,
  beginTracedTransaction,
  endTracedTransaction,
  noteConnectionAcquired,
  setTraceOwnerResolver,
} from '../../db/connection-trace.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/tenant-context.js';

const als = new AsyncLocalStorage<object>();

describe('connection trace owner', () => {
  afterAll(() => {
    _setConnectionTracing(false);
    setTraceOwnerResolver(getCurrentTenantTrx);
  });

  it('counts the window owner, not work running in another context', async () => {
    setTraceOwnerResolver(() => als.getStore());
    _setConnectionTracing(true);
    const request = {};
    const background = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Started before the window, in its own context: a delivery left behind.
    const other = als.run(background, async () => {
      await gate;
      noteConnectionAcquired();
    });
    await als.run(request, async () => {
      beginTracedTransaction();
      release();
      await other;
      expect(endTracedTransaction()).toBe(0);

      beginTracedTransaction();
      noteConnectionAcquired(); // the request itself reaching for the pool
      expect(endTracedTransaction()).toBe(1);
    });
  });
});

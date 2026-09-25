/**
 * PgNotifyRealtimeBus — start/stop with a mocked Bun.SQL.subscribe (no live Postgres).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { PgNotifyRealtimeBus } from '../../lib/runtime/realtime-bus.js';
import * as wsModule from '../../routes/ws.js';

type ListenCallback = (raw: string) => void;

let listenCallback: ListenCallback | undefined;
const OriginalBunSQL = Bun.SQL;

beforeEach(() => {
  listenCallback = undefined;
  // @ts-expect-error — replace Bun.SQL for the duration of the suite
  Bun.SQL = class MockBunSQL {
    // biome-ignore lint/complexity/noUselessConstructor: types the argument. Removing it makes the class take ZERO arguments — measured: `Expected 0 arguments, but got 1` on every `new` below.
    constructor(_url: string) {}
    async subscribe(_channel: string, cb: ListenCallback) {
      listenCallback = cb;
      return { unsubscribe: async () => {} };
    }
  };
});

afterEach(() => {
  Bun.SQL = OriginalBunSQL;
  listenCallback = undefined;
});

describe('PgNotifyRealtimeBus start/stop (mocked Bun.SQL)', () => {
  it('starts LISTEN, marks running, and forwards record.created to broadcastEvent', async () => {
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      await bus.start();
      expect(bus.isRunning).toBe(true);
      expect(listenCallback).toBeDefined();

      listenCallback!(
        JSON.stringify({
          originId: 'other-engine',
          event: 'record.created',
          collection: 'contacts',
          record_id: 'r-new',
          data: { id: 'r-new', title: 'Hello' },
          timestamp: '2026-07-11T00:00:00Z',
          tenantId: 'tenant-1',
        }),
      );
      expect(spy).toHaveBeenCalledWith(
        'contacts',
        'insert',
        { id: 'r-new', title: 'Hello' },
        'tenant-1',
      );

      await bus.stop();
      expect(bus.isRunning).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores malformed JSON payloads from LISTEN', async () => {
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      await bus.start();
      listenCallback!('{not valid json');
      expect(spy).not.toHaveBeenCalled();
      await bus.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('treats missing subscribe as single-instance mode without throwing', async () => {
    // @ts-expect-error — simulate older Bun without subscribe()
    Bun.SQL = class NoSubscribeSQL {
      // biome-ignore lint/complexity/noUselessConstructor: types the argument. Removing it makes the class take ZERO arguments — measured: `Expected 0 arguments, but got 1` on every `new` below.
      constructor(_url: string) {}
    };
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    await expect(bus.start()).resolves.toBeUndefined();
    expect(bus.isRunning).toBe(false);
  });
});

describe('PgNotifyRealtimeBus reconnect', () => {
  // A NOTIFY sent while LISTEN was down is never redelivered, so a missed policy
  // revoke would otherwise wait for the next reconcile tick.
  it('reconciles the policy table once LISTEN is re-established', async () => {
    const onClose: Array<() => void> = [];
    // @ts-expect-error — a subscription that can be closed from the test
    Bun.SQL = class ClosableSQL {
      // biome-ignore lint/complexity/noUselessConstructor: types the argument.
      constructor(_url: string) {}
      async subscribe(_channel: string, _cb: ListenCallback) {
        return {
          unsubscribe: async () => {},
          on: (event: string, h: () => void) => {
            if (event === 'close') onClose.push(h);
          },
        };
      }
    };
    const tenancy = await import('../../lib/tenancy/index.js');
    const spy = spyOn(tenancy, 'reconcilePolicies').mockResolvedValue(false);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    try {
      await bus.start();
      expect(spy).not.toHaveBeenCalled();
      onClose[0]!();
      await Bun.sleep(1_200); // first reconnect is armed at 1 s
      expect(bus.isRunning).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await bus.stop();
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

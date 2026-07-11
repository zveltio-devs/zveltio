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
      constructor(_url: string) {}
    };
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    await expect(bus.start()).resolves.toBeUndefined();
    expect(bus.isRunning).toBe(false);
  });
});

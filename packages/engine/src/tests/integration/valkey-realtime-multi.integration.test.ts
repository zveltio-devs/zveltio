/**
 * Live Valkey pub/sub path for cross-instance realtime.
 *
 * Skipped when VALKEY_URL is unset. Uses one ValkeyRealtimeBus subscriber plus
 * a raw ioredis publisher with a foreign originId (same-process buses share
 * ORIGIN_ID and would drop each other's messages as self-echo).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import Redis from 'ioredis';
import * as wsModule from '../../routes/ws.js';

const VALKEY_URL = process.env.VALKEY_URL;
const CHANNEL = 'zveltio:realtime';

describe.skipIf(!VALKEY_URL)('Valkey realtime multi-instance (live)', () => {
  it('subscriber dispatches a foreign publish from another publisher', async () => {
    const { ValkeyRealtimeBus } = await import('../../lib/runtime/realtime-bus.js');
    const bus = new ValkeyRealtimeBus(VALKEY_URL!);
    const publisher = new Redis(VALKEY_URL!, { maxRetriesPerRequest: 1 });
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});

    try {
      await bus.start();
      await Bun.sleep(100);

      const foreign = {
        originId: 'eng-foreign-test',
        event: 'record.updated',
        collection: 'zvd_contacts',
        record_id: 'multi-1',
        data: { id: 'multi-1' },
        timestamp: new Date().toISOString(),
        tenantId: 't-multi',
      };
      await publisher.publish(CHANNEL, JSON.stringify(foreign));

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && spy.mock.calls.length === 0) {
        await Bun.sleep(50);
      }

      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const [collection, event, data, tenantId] = spy.mock.calls[0]!;
      expect(collection).toBe('zvd_contacts');
      expect(event).toBe('update');
      expect((data as { id: string }).id).toBe('multi-1');
      expect(tenantId).toBe('t-multi');
    } finally {
      spy.mockRestore();
      await bus.stop().catch(() => undefined);
      await publisher.quit().catch(() => undefined);
    }
  }, 10_000);
});

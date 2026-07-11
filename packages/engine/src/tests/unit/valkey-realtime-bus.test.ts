/**
 * ValkeyRealtimeBus — start/publish/subscribe with a fake ioredis (no live Valkey).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as wsModule from '../../routes/ws.js';

type MessageHandler = (channel: string, raw: string) => void;

let messageHandler: MessageHandler | undefined;
const publishLog: Array<{ channel: string; payload: string }> = [];

class FakeRedis {
  constructor(_url: string, _opts?: unknown) {}
  async connect(): Promise<void> {}
  async quit(): Promise<void> {}
  async subscribe(_channel: string): Promise<void> {}
  async unsubscribe(_channel: string): Promise<void> {}
  on(event: string, handler: MessageHandler): void {
    if (event === 'message') messageHandler = handler;
  }
  async publish(channel: string, payload: string): Promise<number> {
    publishLog.push({ channel, payload });
    return 1;
  }
}

mock.module('ioredis', () => ({ default: FakeRedis }));

const { ValkeyRealtimeBus, _ORIGIN_ID } = await import('../../lib/runtime/realtime-bus.js');

beforeEach(() => {
  messageHandler = undefined;
  publishLog.length = 0;
});

afterEach(() => {
  messageHandler = undefined;
});

describe('ValkeyRealtimeBus (mocked ioredis)', () => {
  it('starts, publishes JSON with originId, and isRunning reflects state', async () => {
    const bus = new ValkeyRealtimeBus('redis://localhost:6379');
    expect(bus.isRunning).toBe(false);
    await bus.start();
    expect(bus.isRunning).toBe(true);

    await bus.publish({
      event: 'record.created',
      collection: 'contacts',
      record_id: 'r1',
      data: { id: 'r1' },
      timestamp: new Date().toISOString(),
      tenantId: 't1',
    });

    expect(publishLog).toHaveLength(1);
    expect(publishLog[0]!.channel).toBe('zveltio:realtime');
    const parsed = JSON.parse(publishLog[0]!.payload) as { originId: string; event: string };
    expect(parsed.originId).toBe(_ORIGIN_ID);
    expect(parsed.event).toBe('record.created');

    await bus.stop();
    expect(bus.isRunning).toBe(false);
  });

  it('dispatches foreign messages to broadcastEvent and drops self-echo', async () => {
    const bus = new ValkeyRealtimeBus('redis://localhost:6379');
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      await bus.start();
      expect(messageHandler).toBeDefined();

      messageHandler!('zveltio:realtime', 'not-json{');
      expect(spy).not.toHaveBeenCalled();

      messageHandler!(
        'zveltio:realtime',
        JSON.stringify({
          originId: _ORIGIN_ID,
          event: 'record.created',
          collection: 'contacts',
          timestamp: new Date().toISOString(),
        }),
      );
      expect(spy).not.toHaveBeenCalled();

      messageHandler!(
        'zveltio:realtime',
        JSON.stringify({
          originId: 'other-engine',
          event: 'record.updated',
          collection: 'contacts',
          data: { id: 'x' },
          tenantId: 'tenant-a',
          timestamp: new Date().toISOString(),
        }),
      );
      expect(spy).toHaveBeenCalledWith('contacts', 'update', { id: 'x' }, 'tenant-a');
    } finally {
      spy.mockRestore();
      await bus.stop();
    }
  });
});

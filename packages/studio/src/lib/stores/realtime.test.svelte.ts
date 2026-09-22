import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `disconnect()` is called at sign-out. It closed the socket and dropped its
 * reference — and the `close` listener then scheduled a reconnect, because it
 * cannot tell a deliberate close from a dropped connection. So signing out
 * reopened the socket, now without a valid session, and the failure rescheduled
 * itself with backoff: a signed-out tab talking to the engine forever.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Set<(e: unknown) => void>>();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    // A real browser fires `close` asynchronously, which is the whole bug: by
    // the time it lands, `disconnect()` has already finished.
    setTimeout(() => this.emit('close'), 0);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }
}

let realtime: typeof import('./realtime.svelte.js').realtime;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.resetModules();
  realtime = (await import('./realtime.svelte.js')).realtime;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime — deliberate disconnect', () => {
  it('does not reconnect after disconnect()', async () => {
    realtime.onCollection('invoices', () => {});
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0].emit('open');

    realtime.disconnect();
    // Past the close event AND past the longest backoff a reconnect would use.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(FakeSocket.instances, 'a signed-out tab reopened the socket').toHaveLength(1);
    expect(realtime.connected).toBe(false);
  });

  it('still reconnects when the connection drops on its own', async () => {
    realtime.onCollection('invoices', () => {});
    FakeSocket.instances[0].emit('open');

    FakeSocket.instances[0].emit('close');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it('a later subscribe after disconnect opens a fresh socket', async () => {
    realtime.onCollection('invoices', () => {});
    FakeSocket.instances[0].emit('open');
    realtime.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);

    realtime.onCollection('orders', () => {});
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

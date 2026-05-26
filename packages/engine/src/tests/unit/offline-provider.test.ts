import { describe, it, expect } from 'bun:test';
import {
  createOfflineProvider,
  ElectricNotConfigured,
  ElectricUnavailable,
} from '@zveltio/sdk/offline';

/**
 * S5-07 full — offline-sync provider factory.
 *
 * `crdt` is the default working path. `electric` mints a JWT from the
 * engine and opens a websocket. We mock both the fetch + WebSocket so
 * the test doesn't require a real Electric service.
 */

describe('S5-07 createOfflineProvider — crdt path', () => {
  it('builds a working stub for the default crdt provider', async () => {
    const p = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });
    expect(p.kind).toBe('crdt');
    expect(typeof p.pull).toBe('function');
    expect(typeof p.push).toBe('function');
    expect(typeof p.subscribe).toBe('function');
    expect(typeof p.close).toBe('function');
  });

  it('pull/push/subscribe/close all callable without throw on the CRDT shim', async () => {
    const p = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });
    await expect(p.pull()).resolves.toBeUndefined();
    await expect(p.push()).resolves.toBe(0);
    const off = p.subscribe('zvd_contacts', () => {
      /* */
    });
    expect(typeof off).toBe('function');
    off();
    await expect(p.close()).resolves.toBeUndefined();
  });
});

// ── Mocks for the electric path ────────────────────────────────────────────

interface FakeSocketHandlers {
  open?: () => void;
  message?: (ev: { data: string }) => void;
  error?: (ev: { message?: string }) => void;
}

class FakeWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readonly CLOSED = 3 as const;

  readyState: number = 0;
  url: string;
  sent: string[] = [];
  private handlers: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    // Simulate async connect — microtask later, fire `open`.
    queueMicrotask(() => {
      this.readyState = 1;
      this.handlers.open?.forEach((h) => h({}));
    });
  }
  addEventListener(name: string, fn: (ev: unknown) => void) {
    (this.handlers[name] ||= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }

  // Test helper — drive a fake server message.
  _emitMessage(msg: object) {
    this.handlers.message?.forEach((h) => h({ data: JSON.stringify(msg) }));
  }
}

function makeFetchStub(opts: { status: number; body: object }): typeof fetch {
  return (async () => ({
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    async json() {
      return opts.body;
    },
  })) as unknown as typeof fetch;
}

describe('S5-07 createOfflineProvider — electric provider', () => {
  it('mints a token + opens a websocket against the engine-provided URL', async () => {
    const fetchStub = makeFetchStub({
      status: 200,
      body: {
        token: 'jwt-test',
        expiresAt: Date.now() + 60_000,
        electricUrl: 'wss://electric.example.com',
      },
    });

    const p = await createOfflineProvider({
      engineUrl: 'http://engine',
      provider: 'electric',
      fetch: fetchStub,
      websocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(p.kind).toBe('electric');
    // pull/push are no-ops on Electric (continuous sync handles both).
    await expect(p.pull()).resolves.toBeUndefined();
    await expect(p.push()).resolves.toBe(0);
    await p.close();
  });

  it('subscribe routes incoming change messages to the right callback', async () => {
    const fetchStub = makeFetchStub({
      status: 200,
      body: {
        token: 'jwt-test',
        expiresAt: Date.now() + 60_000,
        electricUrl: 'wss://electric.example.com',
      },
    });

    // Capture the fake socket via a constructor wrapper so we can call
    // `_emitMessage` on it inside the test.
    let captured: FakeWebSocket | null = null;
    class CapturingFake extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        captured = this;
      }
    }

    const p = await createOfflineProvider({
      engineUrl: 'http://engine',
      provider: 'electric',
      fetch: fetchStub,
      websocket: CapturingFake as unknown as typeof WebSocket,
    });

    const received: unknown[][] = [];
    const off = p.subscribe('zvd_contacts', (rows) => received.push(rows));
    expect(captured).not.toBeNull();

    captured!._emitMessage({ type: 'change', table: 'zvd_contacts', rows: [{ id: '1' }] });
    captured!._emitMessage({ type: 'change', table: 'zvd_orders', rows: [{ id: '2' }] });

    expect(received).toEqual([[{ id: '1' }]]);

    // Subscribe sends a subscribe frame.
    expect(captured!.sent.some((s) => s.includes('"subscribe"'))).toBe(true);

    off();
    expect(captured!.sent.some((s) => s.includes('"unsubscribe"'))).toBe(true);
    await p.close();
  });

  it('throws ElectricUnavailable when engine reports 503', async () => {
    const fetchStub = makeFetchStub({
      status: 503,
      body: { error: 'ELECTRIC_URL must be set' },
    });
    let caught: Error | null = null;
    try {
      await createOfflineProvider({
        engineUrl: 'http://engine',
        provider: 'electric',
        fetch: fetchStub,
        websocket: FakeWebSocket as unknown as typeof WebSocket,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ElectricUnavailable);
    expect(caught!.message).toContain('ELECTRIC_URL');
  });

  it('throws ElectricUnavailable when engine returns 401', async () => {
    const fetchStub = makeFetchStub({ status: 401, body: { error: 'Unauthorized' } });
    let caught: Error | null = null;
    try {
      await createOfflineProvider({
        engineUrl: 'http://engine',
        provider: 'electric',
        fetch: fetchStub,
        websocket: FakeWebSocket as unknown as typeof WebSocket,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ElectricUnavailable);
    expect(caught!.message).toContain('sign in');
  });

  it('error messages point at the migration path (mention crdt as the working alternative)', async () => {
    const fetchStub = makeFetchStub({ status: 503, body: { error: 'down' } });
    let caught: Error | null = null;
    try {
      await createOfflineProvider({
        engineUrl: 'http://engine',
        provider: 'electric',
        fetch: fetchStub,
        websocket: FakeWebSocket as unknown as typeof WebSocket,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message.toLowerCase()).toContain('crdt');
  });

  it('ElectricNotConfigured ctor still exports correctly', () => {
    const e = new ElectricNotConfigured('test');
    expect(e.name).toBe('ElectricNotConfigured');
    expect(e.message).toContain('crdt');
  });
});

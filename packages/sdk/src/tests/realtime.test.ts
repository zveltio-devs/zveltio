import { describe, it, expect, afterEach, jest, spyOn } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RealtimeClient } from '../client/RealtimeClient.js';
import { ZveltioClient } from '../client/ZveltioClient.js';
import { ZveltioRealtime } from '../realtime.js';
import { watchSchema } from '../schema-watcher.js';

const RealWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
});

/** Records the constructor arguments instead of dialling out. */
function captureSockets(): unknown[][] {
  const calls: unknown[][] = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    constructor(...args: unknown[]) {
      calls.push(args);
    }
    close() {}
    send() {}
  } as unknown as typeof WebSocket;
  return calls;
}

describe('ZveltioRealtime upgrade headers', () => {
  // `/api/ws` accepts an API key in `X-API-Key`; a server-side client had no
  // way to send one, so it could read a collection over REST and never
  // subscribe to it.
  it('passes headers to the socket when given', () => {
    const calls = captureSockets();
    const rt = new ZveltioRealtime('https://engine.test', { headers: { 'X-API-Key': 'zvk_x' } });
    rt.connect();
    expect(calls[0]).toEqual(['wss://engine.test/api/ws', { headers: { 'X-API-Key': 'zvk_x' } }]);
    rt.disconnect();
  });

  it('uses the one-argument constructor without them', () => {
    const calls = captureSockets();
    const rt = new ZveltioRealtime('http://engine.test');
    rt.connect();
    expect(calls[0]).toEqual(['ws://engine.test/api/ws']);
    rt.disconnect();
  });
});

interface FakeSocket {
  args: unknown[];
  readyState: number;
  sent: string[];
  onopen?: () => void;
  onclose?: (e: { code: number }) => void;
}

/** Fake sockets that record themselves, so a test can open or close one. */
function fakeSockets() {
  const made: FakeSocket[] = [];
  globalThis.WebSocket = class {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    args: unknown[];
    onopen?: () => void;
    onclose?: (e: { code: number }) => void;
    constructor(...args: unknown[]) {
      this.args = args;
      made.push(this);
    }
    close() {}
    send(p: string) {
      this.sent.push(p);
    }
  } as unknown as typeof WebSocket;
  return made;
}

/** Close a fake socket as the runtime does: CLOSED first, then the event. */
function closeWith(ws: FakeSocket, code: number) {
  ws.readyState = 3;
  ws.onclose?.({ code });
}

/** Drive a fake socket to OPEN, as the engine accepting the upgrade would. */
function accept(ws: FakeSocket) {
  ws.readyState = 1;
  ws.onopen?.();
}

describe('a socket the engine closed for revoked credentials', () => {
  // The engine closes with 4001 when the session or key is revoked, and every
  // reconnect is then refused with 401 — retrying only hammered the engine.
  afterEach(() => jest.useRealTimers());

  it('ZveltioRealtime stops reconnecting on 4001 and says so', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new ZveltioRealtime('http://engine.test');
    let told = 0;
    rt.onUnauthorized(() => told++);
    rt.connect();
    closeWith(made[0]!, 4001);
    jest.advanceTimersByTime(60_000);
    expect(made).toHaveLength(1);
    expect(told).toBe(1);
    rt.disconnect();
  });

  it('ZveltioRealtime still reconnects on any other close', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new ZveltioRealtime('http://engine.test');
    let told = 0;
    rt.onUnauthorized(() => told++);
    rt.connect();
    closeWith(made[0]!, 1006);
    jest.advanceTimersByTime(1_000);
    expect(made).toHaveLength(2);
    expect(told).toBe(0);
    rt.disconnect();
  });

  it('RealtimeClient stops reconnecting on 4001 and says so', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new RealtimeClient('http://engine.test');
    let told = 0;
    rt.onUnauthorized(() => told++);
    rt.connect();
    closeWith(made[0]!, 4001);
    jest.advanceTimersByTime(60_000);
    expect(made).toHaveLength(1);
    expect(told).toBe(1);
    rt.disconnect();
  });

  it('RealtimeClient still reconnects on any other close', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new RealtimeClient('http://engine.test');
    rt.connect();
    closeWith(made[0]!, 1006);
    jest.advanceTimersByTime(1_000);
    expect(made).toHaveLength(2);
    rt.disconnect();
  });
});

describe('RealtimeClient after a revocation and while the engine refuses it', () => {
  afterEach(() => jest.useRealTimers());

  it('after 4001, subscribe() only records; an explicit connect() sends it', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new RealtimeClient('http://engine.test');
    rt.connect();
    closeWith(made[0]!, 4001);

    // It used to dial again here, be refused with 401 (seen as 1006) and back
    // off forever.
    rt.subscribe('orders', '*', () => {});
    jest.advanceTimersByTime(600_000);
    expect(made).toHaveLength(1);

    rt.connect(); // the app re-authenticated
    expect(made).toHaveLength(2);
    accept(made[1]!);
    expect(made[1]!.sent).toEqual([JSON.stringify({ type: 'subscribe', channel: 'orders:*' })]);
    rt.disconnect();
  });

  it('stops after a bounded number of reconnects', () => {
    jest.useFakeTimers();
    const made = fakeSockets();
    const rt = new RealtimeClient('http://engine.test');
    rt.connect();
    // A refused handshake: no runtime shows the 401, only a 1006/1002 close.
    for (let i = 0; i < 20; i++) {
      closeWith(made[made.length - 1]!, 1006);
      jest.advanceTimersByTime(30_000);
    }
    expect(made).toHaveLength(11); // the first dial and ten retries
    rt.disconnect();
  });

  it('sends its headers with the upgrade', () => {
    const made = fakeSockets();
    const rt = new RealtimeClient('https://engine.test', { headers: { 'X-API-Key': 'zvk_x' } });
    rt.connect();
    expect(made[0]!.args).toEqual([
      'wss://engine.test/api/ws',
      { headers: { 'X-API-Key': 'zvk_x' } },
    ]);
    rt.disconnect();
  });

  it('ZveltioClient sends its API key on the socket and reports a 4001 as unauthorized', () => {
    const made = fakeSockets();
    let told = 0;
    const client = new ZveltioClient({
      baseUrl: 'https://engine.test',
      apiKey: 'zvk_y',
      onUnauthorized: () => told++,
    });
    client.realtime.connect();
    expect(made[0]!.args).toEqual([
      'wss://engine.test/api/ws',
      { headers: { 'X-API-Key': 'zvk_y' } },
    ]);
    closeWith(made[0]!, 4001);
    expect(told).toBe(1);
    client.realtime.disconnect();
  });
});

describe('watchSchema', () => {
  // It dialled the socket with no credentials, so the engine refused every
  // upgrade (401) and the watcher reconnected every few seconds, forever.
  it('sends its API key with the upgrade', async () => {
    let upgradeKey: string | null | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/api/collections') return Response.json({ collections: [] });
        if (url.pathname === '/api/ws') {
          upgradeKey = req.headers.get('x-api-key');
          if (upgradeKey !== 'zvk_watch') return new Response('Unauthorized', { status: 401 });
          return srv.upgrade(req) ? undefined : new Response('no upgrade', { status: 426 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: { message() {} },
    });
    const out = `${tmpdir()}/zveltio-watch-${Date.now()}.d.ts`;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const stop = await watchSchema(`http://127.0.0.1:${server.port}`, out, { apiKey: 'zvk_watch' });
    try {
      for (let i = 0; i < 100 && upgradeKey === undefined; i++) await Bun.sleep(10);
      expect(upgradeKey).toBe('zvk_watch');
      for (
        let i = 0;
        i < 100 && !log.mock.calls.some((c) => String(c[0]).includes('connected'));
        i++
      ) {
        await Bun.sleep(10);
      }
      expect(log.mock.calls.some((c) => String(c[0]).includes('Schema watcher connected'))).toBe(
        true,
      );
    } finally {
      stop();
      log.mockRestore();
      server.stop(true);
      await rm(out, { force: true });
    }
  });
});

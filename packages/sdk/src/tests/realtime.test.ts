import { describe, it, expect, afterEach } from 'bun:test';
import { ZveltioRealtime } from '../realtime.js';

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

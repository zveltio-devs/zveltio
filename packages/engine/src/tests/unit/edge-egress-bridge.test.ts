/**
 * The engine end of the edge egress channel, on what only a tampered sandbox
 * bootstrap would send: the real one never writes these (edge-egress.test.ts
 * covers what it does write).
 */

import { describe, expect, it } from 'bun:test';
import {
  createEgressBridge,
  EGRESS_LIMITS,
  egressAllows,
  parseEgress,
} from '../../lib/edge-functions/egress.js';

function bridge() {
  const replies: string[] = [];
  const kills: string[] = [];
  const b = createEgressBridge(
    ['api.allowed.test'],
    1000,
    (l) => replies.push(l),
    (why) => kills.push(why),
  );
  return { b, replies, kills };
}

describe('egress bridge bounds', () => {
  it('kills an invocation that sends an oversized or unreadable request line', () => {
    const big = bridge();
    big.b.line('x'.repeat(EGRESS_LIMITS.lineBytes + 1));
    expect(big.kills).toEqual([`egress request exceeds ${EGRESS_LIMITS.lineBytes} bytes`]);

    const junk = bridge();
    junk.b.line('not json');
    expect(junk.kills).toEqual(['malformed egress request']);
  });

  it('answers a malformed request with an error instead of sending it', async () => {
    const { b, replies, kills } = bridge();
    b.line(JSON.stringify({ id: 1, url: 'https://api.allowed.test/', method: 'G E T' }));
    await Bun.sleep(20);
    expect(kills).toEqual([]);
    expect(JSON.parse(replies[0])).toEqual({
      id: 1,
      ok: false,
      error: '[egress] malformed request',
    });
  });
});

describe('egress declarations', () => {
  it('reads the column: NULL declares nothing, every entry a lower-case host', () => {
    expect(parseEgress(null)).toBeNull();
    expect(parseEgress(undefined)).toBeNull();
    expect(parseEgress([])).toEqual([]);
    expect(parseEgress(['api.x.com', 'b.y.io:8443', '[2001:db8::1]'])).toEqual([
      'api.x.com',
      'b.y.io:8443',
      '[2001:db8::1]',
    ]);
    for (const bad of [['API.x.com'], ['a.com', ''], ['a.com b.com'], [null], [7]]) {
      expect(() => parseEgress(bad)).toThrow('is not a host');
    }
    expect(() => parseEgress('a.com' as unknown as string[])).toThrow('not a list');
  });

  it('matches the authority exactly', () => {
    const list = ['api.x.com', 'b.y.io:8443'];
    const ok = (u: string) => egressAllows(list, new URL(u));
    expect(ok('https://api.x.com/p')).toBe(true);
    expect(ok('http://api.x.com/p')).toBe(true);
    expect(ok('https://api.x.com:443/p')).toBe(true);
    expect(ok('https://api.x.com:8443/p')).toBe(false);
    expect(ok('https://sub.api.x.com/')).toBe(false);
    expect(ok('https://api.x.com.evil.test/')).toBe(false);
    expect(ok('https://b.y.io:8443/')).toBe(true);
    expect(ok('https://b.y.io/')).toBe(false);
    expect(ok('ws://api.x.com/')).toBe(false);
  });
});

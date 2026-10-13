import { describe, expect, it } from 'bun:test';
import { encodeFrame, FrameDecoder } from '../../lib/worker-extension-transport.js';

const roundTrip = (msg: unknown) => new FrameDecoder().push(encodeFrame(msg))[0];

describe('process transport carries values plain JSON loses', () => {
  it('bigint, Date and bytes cross as themselves', () => {
    const d = new Date('2026-10-13T12:00:00.000Z');
    const out = roundTrip({ args: [10n ** 20n, d, Buffer.from('hi'), new Uint8Array([1, 2])] }) as {
      args: unknown[];
    };
    expect(out.args[0]).toBe(10n ** 20n);
    expect(out.args[1]).toEqual(d);
    expect(out.args[1]).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(out.args[2])).toBe(true);
    expect((out.args[2] as Buffer).toString()).toBe('hi');
    expect([...(out.args[3] as Buffer)]).toEqual([1, 2]);
  });

  it('a payload that spells the tag stays a plain object', () => {
    const forged = { $zv: 'date', v: '2026-01-01' };
    expect(
      roundTrip({ p: forged, nested: [{ $zv: 'bigint', v: '1', x: { $zv: 'bytes' } }] }),
    ).toEqual({
      p: forged,
      nested: [{ $zv: 'bigint', v: '1', x: { $zv: 'bytes' } }],
    });
  });

  it('a malformed tag from the peer ends the channel rather than decoding', () => {
    const body = new TextEncoder().encode('{"$zv":"bigint","v":"zz"}');
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    expect(() => new FrameDecoder().push(frame)).toThrow();
  });
});

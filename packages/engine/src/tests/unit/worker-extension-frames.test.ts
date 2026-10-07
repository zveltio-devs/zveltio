// Frames of the runner transport: whatever way the bytes are chunked, the same
// messages come out, and a frame past the cap ends the channel instead of
// buffering without bound.
import { describe, expect, it } from 'bun:test';
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
} from '../../lib/worker-extension-transport.js';

const msgs = [
  { type: 'ping', id: 'p-1' },
  { type: 'log', level: 'log', message: 'ünïcødé ✓ and a "quote"' },
  { type: 'route:ok', id: 'r-1', status: 200, body: 'x'.repeat(200_000) },
];
const bytes = (() => {
  const parts = msgs.map(encodeFrame);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
})();

describe('runner frames', () => {
  it('one chunk holding every frame', () => {
    expect(new FrameDecoder().push(bytes)).toEqual(msgs);
  });

  it('one byte at a time', () => {
    const dec = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...dec.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual(msgs);
  });

  it('chunks that split headers and bodies anywhere', () => {
    const dec = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 7_001)
      out.push(...dec.push(bytes.subarray(i, i + 7_001)));
    expect(out).toEqual(msgs);
  });

  it('a header announcing more than the cap throws before buffering it', () => {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(head)).toThrow(/exceeds/);
  });

  it('a frame that is not JSON throws', () => {
    const body = new TextEncoder().encode('{not json');
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    expect(() => new FrameDecoder().push(frame)).toThrow();
  });

  it('the sender refuses a message past the cap', () => {
    expect(() => encodeFrame({ body: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/exceeds/);
  });
});

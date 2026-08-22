/**
 * pg_notify payload sizing — bytes, not UTF-16 code units.
 *
 * Postgres caps the NOTIFY payload at 8000 BYTES. `String.length` counts UTF-16
 * code units, and `JSON.stringify` does not escape non-ASCII, so any accented
 * text encodes larger in bytes than in code units. Measured the wrong way, a
 * record of Romanian text clears the guard and is then rejected by the server —
 * realtime that works for ASCII and silently does not for everything else.
 */

import { describe, expect, it } from 'bun:test';
import {
  PG_NOTIFY_PAYLOAD_MAX,
  PgNotifyRealtimeBus,
  trimForPgNotify,
} from '../../lib/runtime/realtime-bus.js';

/** Postgres' hard limit. PG_NOTIFY_PAYLOAD_MAX sits just under it. */
const PG_HARD_CAP = 8000;

function message(note: string) {
  return {
    event: 'record.updated',
    collection: 'contacts',
    record_id: '6f1e2c4a-0000-0000-0000-000000000001',
    data: { note },
    timestamp: '2026-08-22T10:00:00.000Z',
    tenantId: null,
  };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('trimForPgNotify sizes payloads in bytes', () => {
  it('keeps an ASCII payload that fits under the cap intact', () => {
    const msg = message('plain ascii note');
    const out = trimForPgNotify(msg);
    expect(out.data).toEqual(msg.data);
    expect(bytes(out)).toBeLessThanOrEqual(PG_NOTIFY_PAYLOAD_MAX);
  });

  it('trims a diacritics payload that passes a code-unit check but exceeds the byte cap', () => {
    // Calibrated into the window: under PG_NOTIFY_PAYLOAD_MAX by String.length,
    // over Postgres' 8000-byte cap by UTF-8 byte count.
    const note = 'Situație frumoasă în București. '.repeat(230);
    const msg = message(note);

    const untrimmedLength = JSON.stringify({ ...msg, originId: 'eng-00000000' }).length;
    const untrimmedBytes = bytes({ ...msg, originId: 'eng-00000000' });
    expect(untrimmedLength).toBeLessThanOrEqual(PG_NOTIFY_PAYLOAD_MAX); // a length check would pass
    expect(untrimmedBytes).toBeGreaterThan(PG_HARD_CAP); // …and Postgres would reject it

    const out = trimForPgNotify(msg);
    expect(out.data).toBeUndefined(); // degraded to id-only; dispatchToWs falls back
    expect(out.record_id).toBe(msg.record_id);
    expect(out.tenantId).toBeNull();
    expect(bytes(out)).toBeLessThanOrEqual(PG_NOTIFY_PAYLOAD_MAX);
  });

  it('trims a payload that is oversized by both measures', () => {
    const out = trimForPgNotify(message('x'.repeat(20_000)));
    expect(out.data).toBeUndefined();
    expect(bytes(out)).toBeLessThanOrEqual(PG_NOTIFY_PAYLOAD_MAX);
  });
});

describe('publish does not reconnect LISTEN on a publish failure', () => {
  it('logs the failure and leaves the subscription running', async () => {
    const bus = new PgNotifyRealtimeBus('postgres://localhost/zveltio_test');
    // Drive publish directly: the subscriber half is never started, so if
    // publish tried to recover the listener it would have to touch it here.
    bus.setPublisher({
      notify: async () => {
        throw new Error('payload string too long for NOTIFY');
      },
    });

    const before = bus.isRunning;
    await bus.publish(message('boom')); // must not throw
    expect(bus.isRunning).toBe(before);
  });
});

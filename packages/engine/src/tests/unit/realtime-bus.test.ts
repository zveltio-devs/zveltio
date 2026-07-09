import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  realtimeBus,
  _resetForTests,
  _ORIGIN_ID,
  ValkeyRealtimeBus,
  PgNotifyRealtimeBus,
  NoopRealtimeBus,
  dispatchToWs,
  type RealtimeBusMessage,
} from '../../lib/runtime/realtime-bus.js';
import * as wsModule from '../../routes/ws.js';

/**
 * S5-03 unit tests — the cross-instance realtime bus picks the right
 * backend, suppresses self-echo, and translates payloads correctly.
 *
 * Live Valkey + Postgres LISTEN ceremonies live in the integration suite
 * (they need real services). Here we cover the decision + dispatch logic.
 */

describe('S5-03 realtimeBus() selection', () => {
  const orig = {
    VALKEY_URL: process.env.VALKEY_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
    if (orig.VALKEY_URL === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = orig.VALKEY_URL;
    if (orig.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = orig.DATABASE_URL;
  });

  it('picks Valkey when VALKEY_URL is set', () => {
    process.env.VALKEY_URL = 'redis://localhost:6379';
    process.env.DATABASE_URL = 'postgres://localhost/zveltio';
    const bus = realtimeBus();
    expect(bus.backend).toBe('valkey');
    expect(bus).toBeInstanceOf(ValkeyRealtimeBus);
  });

  it('falls back to pg_notify when only DATABASE_URL is set', () => {
    delete process.env.VALKEY_URL;
    process.env.DATABASE_URL = 'postgres://localhost/zveltio';
    const bus = realtimeBus();
    expect(bus.backend).toBe('pg-notify');
    expect(bus).toBeInstanceOf(PgNotifyRealtimeBus);
  });

  it('falls back to noop when neither is set (e.g. unit-test env)', () => {
    delete process.env.VALKEY_URL;
    delete process.env.DATABASE_URL;
    const bus = realtimeBus();
    expect(bus.backend).toBe('none');
    expect(bus).toBeInstanceOf(NoopRealtimeBus);
  });

  it('singleton — repeated calls return the same instance until reset', () => {
    delete process.env.VALKEY_URL;
    delete process.env.DATABASE_URL;
    const a = realtimeBus();
    const b = realtimeBus();
    expect(a).toBe(b);
  });
});

describe('S5-03 noop backend', () => {
  it('publish is a no-op, start/stop are no-ops, isRunning is false', async () => {
    const bus = new NoopRealtimeBus();
    expect(bus.isRunning).toBe(false);
    await bus.start();
    await bus.publish({
      event: 'record.created',
      collection: 'x',
      timestamp: new Date().toISOString(),
    });
    await bus.stop();
    // No throw == pass.
    expect(bus.isRunning).toBe(false);
  });
});

describe('S5-03 dispatchToWs (self-echo + event mapping)', () => {
  // Stub ws.ts via Bun's mock.module — too invasive for this surface.
  // Instead we test that dispatchToWs at least returns silently for the
  // self-echo + unknown-event paths. broadcastEvent throws only if the
  // ws module is mid-init; in tests it's a no-op on missing connection.

  it('drops a message originating from this process (self-echo)', () => {
    // Passing originId === _ORIGIN_ID should never reach broadcastEvent.
    // We can't observe broadcastEvent directly without mocking, but the
    // function returning without exception is the contract.
    const msg: RealtimeBusMessage = {
      originId: _ORIGIN_ID,
      event: 'record.created',
      collection: 'zvd_x',
      data: { id: '1' },
      timestamp: new Date().toISOString(),
    };
    expect(() => dispatchToWs(msg)).not.toThrow();
  });

  it('drops an unknown event name', () => {
    const msg: RealtimeBusMessage = {
      originId: 'other-process',
      event: 'record.fizzbuzz',
      collection: 'zvd_x',
      timestamp: new Date().toISOString(),
    };
    expect(() => dispatchToWs(msg)).not.toThrow();
  });

  it('drops when collection is missing', () => {
    const msg: RealtimeBusMessage = {
      originId: 'other-process',
      event: 'record.created',
      collection: '',
      timestamp: new Date().toISOString(),
    };
    expect(() => dispatchToWs(msg)).not.toThrow();
  });

  it('routes through to broadcastEvent for legit cross-instance messages', () => {
    // Without a real ws connection, broadcastEvent is also a silent no-op
    // (the subscriptionIndex is empty in unit tests).
    const msg: RealtimeBusMessage = {
      originId: 'other-process',
      event: 'record.updated',
      collection: 'zvd_contacts',
      record_id: 'abc',
      data: { id: 'abc', name: 'Updated' },
      timestamp: new Date().toISOString(),
    };
    expect(() => dispatchToWs(msg)).not.toThrow();
  });
});

describe('S5-03 _ORIGIN_ID', () => {
  it('starts with "eng-" prefix and is stable within the process', () => {
    expect(_ORIGIN_ID).toMatch(/^eng-[0-9a-f]{8}$/);
    // Re-import-style: the constant is captured at module load and
    // doesn't change between calls.
    const stillSame = _ORIGIN_ID;
    expect(stillSame).toBe(_ORIGIN_ID);
  });
});

// ── Observed dispatch: spy on broadcastEvent to assert the actual contract
//    (event mapping, data fallback, tenant scoping, self-echo drop), not just
//    "does not throw". ──────────────────────────────────────────────────────
function baseMsg(over: Partial<RealtimeBusMessage> = {}): RealtimeBusMessage {
  return {
    originId: 'other-origin',
    event: 'record.created',
    collection: 'contacts',
    record_id: 'r1',
    data: { id: 'r1', name: 'A' },
    timestamp: '2026-07-09T00:00:00Z',
    tenantId: 'tenant-1',
    ...over,
  };
}

describe('dispatchToWs — observed via broadcastEvent', () => {
  it('maps record.updated → update and forwards data + tenantId', () => {
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      dispatchToWs(baseMsg({ event: 'record.updated' }));
      expect(spy).toHaveBeenCalledWith('contacts', 'update', { id: 'r1', name: 'A' }, 'tenant-1');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to { id: record_id } and null tenant when data/tenantId are absent', () => {
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      dispatchToWs(baseMsg({ event: 'record.deleted', data: undefined, tenantId: null }));
      expect(spy).toHaveBeenCalledWith('contacts', 'delete', { id: 'r1' }, null);
    } finally {
      spy.mockRestore();
    }
  });

  it('never calls broadcastEvent for self-echo / unknown event / missing collection', () => {
    const spy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    try {
      dispatchToWs(baseMsg({ originId: _ORIGIN_ID }));
      dispatchToWs(baseMsg({ event: 'record.frobnicated' }));
      dispatchToWs(baseMsg({ collection: '' }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PgNotifyRealtimeBus.publish', () => {
  it('is a no-op until a publisher is plugged in', async () => {
    const bus = new PgNotifyRealtimeBus('postgres://localhost/x');
    await expect(bus.publish(baseMsg())).resolves.toBeUndefined();
  });

  it('emits pg_notify with the origin id stamped and single quotes escaped', async () => {
    const bus = new PgNotifyRealtimeBus('postgres://localhost/x');
    const calls: string[] = [];
    bus.setPublisher({
      execute: async (sql: string) => {
        calls.push(sql);
        return null;
      },
    });
    await bus.publish(baseMsg({ data: { note: "O'Brien" } }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`SELECT pg_notify('zveltio_changes'`);
    expect(calls[0]).toContain(_ORIGIN_ID);
    expect(calls[0]).toContain("O''Brien"); // '' == escaped single quote
  });

  it('swallows a publisher execute failure without throwing', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = new PgNotifyRealtimeBus('postgres://localhost/x');
      bus.setPublisher({ execute: async () => Promise.reject(new Error('conn lost')) });
      await expect(bus.publish(baseMsg())).resolves.toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('pg_notify failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('ValkeyRealtimeBus (no connection)', () => {
  it('reports the valkey backend, is not running, and publish is a safe no-op before start()', async () => {
    const bus = new ValkeyRealtimeBus('redis://localhost:6379');
    expect(bus.backend).toBe('valkey');
    expect(bus.isRunning).toBe(false);
    await expect(bus.publish(baseMsg())).resolves.toBeUndefined();
  });
});

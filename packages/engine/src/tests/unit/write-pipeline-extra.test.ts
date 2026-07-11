/**
 * write-pipeline helpers — runAtomic, processInput, afterWrite (CannedDb + spies).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetForTests } from '../../lib/runtime/realtime-bus.js';
import { afterWrite, processInput, runAtomic, isUuid } from '../../lib/data/write-pipeline.js';
import * as wsModule from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

afterEach(() => {
  _resetForTests();
});

describe('runAtomic', () => {
  it('reuses an executor that is already a transaction', async () => {
    const trx = { isTransaction: true } as unknown as Database;
    let sawTrx = false;
    const result = await runAtomic(trx, async (t) => {
      sawTrx = t === trx;
      return 42;
    });
    expect(result).toBe(42);
    expect(sawTrx).toBe(true);
  });

  it('opens a transaction on a pool executor', async () => {
    const db = new CannedDb();
    db.when(/select 1/i, [{ ok: true }]);
    const result = await runAtomic(db.kysely as unknown as Database, async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('processInput', () => {
  it('skips unknown fields in partial mode', async () => {
    const { errors, processed } = await processInput(
      { nickname: 'bob' },
      {
        name: 'contacts',
        fields: [{ name: 'code', type: 'text', required: true, unique: false, indexed: false }],
      } as never,
      true,
    );
    expect(errors).toEqual([]);
    expect(processed).toEqual({});
  });

  it('returns raw data when the collection has no field metadata', async () => {
    const { errors, processed } = await processInput({ a: 1 }, null, false);
    expect(errors).toEqual([]);
    expect(processed).toEqual({ a: 1 });
  });
});

describe('isUuid', () => {
  it('accepts RFC-4122 UUIDs and rejects garbage', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('afterWrite', () => {
  it('writes a revision row, broadcasts, and emits engine events on create', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.created', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-1',
        action: 'create',
        data: { id: 'rec-1', name: 'Ada' },
        userId: 'user-1',
        tenantId: 'tenant-a',
      });
      expect(db.executed(/zv_revisions/i).length).toBe(1);
      expect(wsSpy).toHaveBeenCalledWith(
        'contacts',
        'insert',
        { id: 'rec-1', name: 'Ada' },
        'tenant-a',
      );
      expect(payloads).toHaveLength(1);
    } finally {
      unsub();
      wsSpy.mockRestore();
    }
  });

  it('maps delete actions to delete broadcasts and record.deleted events', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.deleted', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-2',
        action: 'delete',
        data: { id: 'rec-2' },
        delta: { name: 'gone' },
        userId: 'user-2',
        tenantId: null,
      });
      expect(wsSpy).toHaveBeenCalledWith('contacts', 'delete', { id: 'rec-2' }, null);
      expect(payloads).toHaveLength(1);
      const rev = db.executed(/zv_revisions/i)[0]!;
      expect(rev.parameters.some((p) => p === 'delete')).toBe(true);
    } finally {
      unsub();
      wsSpy.mockRestore();
    }
  });

  it('maps update actions to update broadcasts and record.updated events', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.updated', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-3',
        action: 'update',
        data: { id: 'rec-3', name: 'New' },
        delta: { name: 'New' },
        userId: 'user-3',
        tenantId: 'tenant-b',
      });
      expect(wsSpy).toHaveBeenCalledWith(
        'contacts',
        'update',
        { id: 'rec-3', name: 'New' },
        'tenant-b',
      );
      expect(payloads).toHaveLength(1);
    } finally {
      unsub();
      wsSpy.mockRestore();
    }
  });
});

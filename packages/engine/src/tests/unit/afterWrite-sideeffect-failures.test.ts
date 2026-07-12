/**
 * afterWrite — non-fatal realtime/cache side-effect failures (write-pipeline.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { afterWrite } from '../../lib/data/write-pipeline.js';
import * as queryCache from '../../lib/data/query-cache.js';
import { engineEvents } from '../../lib/runtime/index.js';
import * as realtimeBusModule from '../../lib/runtime/realtime-bus.js';
import { _resetForTests } from '../../lib/runtime/realtime-bus.js';
import * as wsModule from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

afterEach(() => {
  _resetForTests();
});

describe('afterWrite — side-effect resilience', () => {
  it('warns when invalidateQueryCache rejects but still emits engine events', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const cacheSpy = spyOn(queryCache, 'invalidateQueryCache').mockRejectedValue(
      new Error('valkey down'),
    );
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.updated', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-1',
        action: 'update',
        data: { id: 'rec-1', name: 'Ada' },
        userId: 'user-1',
        tenantId: 'tenant-a',
      });
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('invalidateQueryCache failed')),
      ).toBe(true);
      expect(payloads).toHaveLength(1);
      expect(wsSpy).toHaveBeenCalled();
    } finally {
      unsub();
      warn.mockRestore();
      cacheSpy.mockRestore();
      wsSpy.mockRestore();
    }
  });

  it('logs when realtimeBus.publish rejects', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const busSpy = spyOn(realtimeBusModule, 'realtimeBus').mockReturnValue({
      publish: async () => {
        throw new Error('bus offline');
      },
    } as never);

    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-2',
        action: 'create',
        data: { id: 'rec-2' },
        userId: 'user-2',
        tenantId: null,
      });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('realtime publish failed'))).toBe(
        true,
      );
    } finally {
      errSpy.mockRestore();
      wsSpy.mockRestore();
      busSpy.mockRestore();
    }
  });
});

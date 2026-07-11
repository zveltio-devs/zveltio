/**
 * afterWrite non-fatal failure paths (lib/data/write-pipeline.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { afterWrite } from '../../lib/data/write-pipeline.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetForTests } from '../../lib/runtime/realtime-bus.js';
import * as wsModule from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

afterEach(() => {
  _resetForTests();
});

describe('afterWrite — swallowed revision failures', () => {
  it('still broadcasts and emits when the revision insert fails', async () => {
    const db = new CannedDb();
    db.fail(/insert into "zv_revisions"/i, new Error('revision table missing'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.created', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-9',
        action: 'create',
        data: { id: 'rec-9' },
        userId: 'user-9',
        tenantId: 'tenant-z',
      });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('revision log failed'))).toBe(
        true,
      );
      expect(wsSpy).toHaveBeenCalled();
      expect(payloads).toHaveLength(1);
    } finally {
      unsub();
      errSpy.mockRestore();
      wsSpy.mockRestore();
    }
  });
});

/**
 * afterWrite — non-fatal flow trigger failures (write-pipeline.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { afterWrite } from '../../lib/data/write-pipeline.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetForTests } from '../../lib/runtime/realtime-bus.js';
import * as flowsModule from '../../routes/flows.js';
import * as wsModule from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

afterEach(() => {
  _resetForTests();
});

describe('afterWrite — flow trigger resilience', () => {
  it('logs when triggerDataFlows rejects but still emits engine events', async () => {
    const db = new CannedDb();
    db.when(/insert into "zv_revisions"/i, []);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const flowSpy = spyOn(flowsModule, 'triggerDataFlows').mockRejectedValue(
      new Error('flow engine offline'),
    );
    const wsSpy = spyOn(wsModule, 'broadcastEvent').mockImplementation(() => {});
    const payloads: unknown[] = [];
    const unsub = engineEvents.on('record.created', (p) => payloads.push(p));
    try {
      await afterWrite(db.kysely as unknown as Database, {
        collection: 'contacts',
        recordId: 'rec-flow',
        action: 'create',
        data: { id: 'rec-flow', name: 'Ada' },
        userId: 'user-1',
        tenantId: 'tenant-a',
      });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('flow trigger failed'))).toBe(
        true,
      );
      expect(payloads).toHaveLength(1);
      expect(wsSpy).toHaveBeenCalled();
    } finally {
      unsub();
      errSpy.mockRestore();
      flowSpy.mockRestore();
      wsSpy.mockRestore();
    }
  });
});

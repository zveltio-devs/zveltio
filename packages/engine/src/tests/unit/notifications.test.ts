/**
 * In-app notification helper (lib/notifications.ts) — inserts into zv_notifications
 * with defaults for optional fields. CannedDb records the compiled SQL.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendNotification } from '../../lib/notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('sendNotification', () => {
  it('inserts a notification with defaults for optional fields', async () => {
    const canned = new CannedDb();
    canned.when(/insert into "zv_notifications"/i, []);
    const db = canned.kysely as unknown as Database;

    await sendNotification(db, {
      user_id: 'u1',
      title: 'Hello',
      message: 'World',
    });

    const insert = canned.executed(/insert into "zv_notifications"/i)[0];
    expect(insert).toBeDefined();
    expect(insert!.sql.toLowerCase()).toContain('zv_notifications');
    expect(insert!.parameters).toContain('u1');
    expect(insert!.parameters).toContain('Hello');
    expect(insert!.parameters).toContain('World');
    expect(insert!.parameters).toContain('info');
  });

  it('serializes metadata and passes through explicit type/source/url', async () => {
    const canned = new CannedDb();
    canned.when(/insert into "zv_notifications"/i, []);
    const db = canned.kysely as unknown as Database;

    await sendNotification(db, {
      user_id: 'u2',
      title: 'T',
      message: 'M',
      type: 'warning',
      source: 'flow',
      action_url: '/x',
      metadata: { flowId: 'f1' },
    });

    const insert = canned.executed(/insert into "zv_notifications"/i)[0]!;
    expect(insert.parameters).toContain('warning');
    expect(insert.parameters).toContain('flow');
    expect(insert.parameters).toContain('/x');
    expect(insert.parameters.some((p) => String(p).includes('flowId'))).toBe(true);
  });
});

/**
 * `GET /resources` enumerates what a permission can be granted ON — collections,
 * plus any rows left in the retired `zvd_zones` on an upgraded database.
 *
 * It carried `.catch(() => [])` on the zones read. Two different facts came back
 * as the same empty list: "this install has no portals extension", which is the
 * common case and true, and "the zones table is there but could not be read",
 * which tells an administrator there is nothing to grant when there may be
 * several. They are told apart by SQLSTATE now — `42P01` is the absent table and
 * is expected; anything else is a failure and is raised.
 *
 * SQLSTATE arrives on `err.errno`, not `err.code`, for this driver.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { registerPermissionRoutes } from '../../routes/admin/permission-routes.js';
import { DDLManager } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function appWith(db: CannedDb): Hono {
  const app = new Hono();
  registerPermissionRoutes(app, db.kysely as unknown as Database);
  return app;
}

describe('GET /resources — zones extension absent vs unreadable', () => {
  it('lists collections and no zones when the table does not exist', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections"/, [
      { name: 'contacts', display_name: 'Contacts', fields: '[]' },
    ]);
    const absent = Object.assign(new Error('relation "zvd_zones" does not exist'), {
      errno: '42P01',
    });
    db.fail(/FROM zvd_zones/, absent);

    const res = await appWith(db).request('/resources');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ type: string }> };
    expect(body.resources.some((r) => r.type === 'zone')).toBe(false);
    // The point: an absent extension costs its own rows, not the collection list.
    expect(body.resources.length).toBeGreaterThan(0);
  });

  it('does NOT answer an unreadable zones table with an empty list', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections"/, [
      { name: 'contacts', display_name: 'Contacts', fields: '[]' },
    ]);
    // A permission error, not a missing table. Under `.catch(() => [])` this
    // rendered as "no zones to grant".
    const denied = Object.assign(new Error('permission denied for table zvd_zones'), {
      errno: '42501',
    });
    db.fail(/FROM zvd_zones/, denied);

    const res = await appWith(db).request('/resources');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

/**
 * DDL an extension runs through the `DDLManager` it is handed reaches the
 * schema watchers, like the host's own routes. ai-alchemist creates a
 * collection and fills it in the same request, so it cannot use the DDL queue,
 * and before this its collections reached no `watchSchema`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { DEFAULT_TENANT_ID, runWithDomain } from '../../lib/tenancy/index.js';
import { _wsPermCacheForTests, SCHEMA_CHANNEL, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = Date.now();
const COLLECTION = `extddl_${TAG}`;
const PROBE = `ws_extddl_${TAG}`;

d("an extension's DDL reaches the schema watchers", () => {
  let app: Hono;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  afterAll(async () => {
    _wsPermCacheForTests().connections.delete(PROBE);
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('announces create, alter and drop made through the handed DDLManager', async () => {
    const god = await createGodSession(app, db);
    const data = await wsUpgradeData(app, { cookie: god });
    expect(data).toBeTruthy();
    const sent: string[] = [];
    const ws = { data: { ...data, id: PROBE }, send: (p: string) => sent.push(p), close: () => {} };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', channel: SCHEMA_CHANNEL }),
    );
    expect(sent.join('\n')).toContain('"subscribed"');

    const field = { name: 'title', type: 'text', required: false, unique: false, indexed: false };
    // An extension's route runs in its request's tenant; so does this.
    await runWithDomain(DEFAULT_TENANT_ID, async () => {
      await announcingDDLManager.createCollection(db, { name: COLLECTION, fields: [field] });
      await announcingDDLManager.addField(db, COLLECTION, { ...field, name: 'body' });
      await announcingDDLManager.dropCollection(db, COLLECTION);
    });

    const actions = () =>
      sent
        .map((f) => JSON.parse(f) as { type: string; collection?: string; action?: string })
        .filter((m) => m.type === 'schema:changed' && m.collection === COLLECTION)
        .map((m) => m.action);
    for (let i = 0; i < 150 && actions().length < 3; i++) await Bun.sleep(20);
    expect(actions()).toEqual(['create', 'alter', 'drop']);
  }, 60_000);
});

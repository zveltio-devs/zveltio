/**
 * DDL an extension runs through the `DDLManager` it is handed reaches the
 * schema watchers, like the host's own routes. ai-alchemist creates a
 * collection and fills it in the same request, so it cannot use the DDL queue,
 * and before this its collections reached no `watchSchema`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
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
const ISOLATED = `extddl_rls_${TAG}`;

d("an extension's DDL reaches the schema watchers", () => {
  let app: Hono;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  afterAll(async () => {
    _wsPermCacheForTests().connections.delete(PROBE);
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
    if (db) await dropTestCollection(db, ISOLATED).catch(() => {});
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

  it('isolates a collection it creates at once, not at the next boot', async () => {
    // The DDL queue applies tenant RLS and the narrow roles' grants right after
    // CREATE TABLE. The DDLManager handed to extensions did not, so a
    // collection ai-alchemist created stayed readable across tenants — no
    // policy, RLS off — until the engine restarted and reconciled it.
    const field = { name: 'title', type: 'text', required: false, unique: false, indexed: false };
    await runWithDomain(DEFAULT_TENANT_ID, () =>
      announcingDDLManager.createCollection(db, { name: ISOLATED, fields: [field] }),
    );
    const table = `zvd_${ISOLATED}`;
    const rls = await sql<{ on: boolean; forced: boolean; policy: string | null }>`
      SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
             (SELECT policyname FROM pg_policies
               WHERE schemaname = 'public' AND tablename = ${table}
                 AND policyname = 'tenant_isolation') AS policy
        FROM pg_class c WHERE c.oid = ${`public.${table}`}::regclass`.execute(db);
    expect(rls.rows[0]).toEqual({ on: true, forced: true, policy: 'tenant_isolation' });
    const grants = await sql<{ grantee: string }>`
      SELECT DISTINCT grantee FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = ${table}
         AND grantee IN (SELECT rolname FROM pg_roles WHERE rolname IN ('zveltio_worker', 'zveltio_flow_reader'))`.execute(
      db,
    );
    const narrow = await sql<{ rolname: string }>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('zveltio_worker', 'zveltio_flow_reader')`.execute(
      db,
    );
    expect(grants.rows.map((r) => r.grantee).sort()).toEqual(
      narrow.rows.map((r) => r.rolname).sort(),
    );
  }, 60_000);
});

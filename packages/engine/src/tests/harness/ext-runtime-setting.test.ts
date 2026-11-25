/**
 * PUT /api/marketplace/:name/runtime (ADR 0062 d3): only god, stepped up, sets
 * whether an extension's worker stays always on or how long it may idle; kept in
 * `zv_settings` as `ext_runtime:<name>`, audited, and shown in the list over the
 * defaults (pos and invoicing always on).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  asAuditOwner,
  asEveryTenant,
  createMemberSession,
  createSteppedUpGod,
  forgetRuntimeSettings,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { readRuntimePolicy } from '../../lib/extensions/runtime-policy.js';

const d = harnessAvailable() ? describe : describe.skip;
const EXT = `rt-ext-${Date.now()}`;

d('extension runtime setting (ADR 0062 d3)', () => {
  let app: Hono;
  let engine: Hono;
  let db: Database;
  let cookie: string;
  const put = (body: unknown, who = cookie, name = EXT) =>
    app.request(`/api/marketplace/${name}/runtime`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: who },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    engine = t.app;
    ({ cookie, app } = await createSteppedUpGod(t.app, db));
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, true, false)`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await forgetRuntimeSettings(db, EXT);
    await asAuditOwner(db, sql`DELETE FROM zv_audit_log WHERE resource_id = ${EXT}`);
  });

  it('defaults: idle after 5 minutes; pos and invoicing always on', async () => {
    expect(await readRuntimePolicy(db, EXT)).toEqual({
      alwaysOn: false,
      idleTimeoutSeconds: 300,
    });
    expect((await readRuntimePolicy(db, 'operations/pos')).alwaysOn).toBe(true);
    expect((await readRuntimePolicy(db, 'finance/invoicing')).alwaysOn).toBe(true);
  });

  it('sets, merges and audits; refuses a bad body and an unknown extension', async () => {
    let res = await put({ idleTimeoutSeconds: 60 });
    expect(res.status).toBe(200);
    res = await put({ alwaysOn: true });
    expect(((await res.json()) as { runtime: unknown }).runtime).toEqual({
      alwaysOn: true,
      idleTimeoutSeconds: 60,
    });
    expect(await readRuntimePolicy(db, EXT)).toEqual({ alwaysOn: true, idleTimeoutSeconds: 60 });
    expect((await put({ idleTimeoutSeconds: 0 })).status).toBe(400);
    expect((await put({ alwaysOn: 'yes' })).status).toBe(400);
    expect((await put({ isolation: 'inline' })).status).toBe(400);
    expect((await put({ alwaysOn: true }, cookie, `${EXT}-absent`)).status).toBe(404);
    const audit = await asEveryTenant(
      db,
      sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_audit_log
                         WHERE event_type = 'extension.runtime_set' AND resource_id = ${EXT}`,
    );
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('refuses a member: where an extension runs is the operator’s', async () => {
    const member = await createMemberSession(engine, db);
    expect((await put({ alwaysOn: false }, member.cookie)).status).toBeGreaterThanOrEqual(401);
    expect((await readRuntimePolicy(db, EXT)).alwaysOn).toBe(true);
  });
});

/**
 * POST /api/marketplace/:name/bind-egress-slot (ADR 0026 decision 3): only god,
 * stepped up, binds a slot a job declares; approving capabilities keeps the
 * binding. What a bound slot reaches is ext-job-runner.test.ts's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { readGranted } from '../../lib/extensions/consent.js';
import { resolveExtensionsBase } from '../../lib/extensions/extension-paths.js';
import { DEFAULT_TENANT_ID, getEnforcer } from '../../lib/tenancy/index.js';
import {
  createMemberSession,
  createSteppedUpGod,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const EXT = `slot-ext-${Date.now()}`;

d('bind-egress-slot', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const call = (action: string, body: unknown, who = cookie, extra: Record<string, string> = {}) =>
    app.request(`/api/marketplace/${EXT}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: who, ...extra },
      body: JSON.stringify(body),
    });
  const bind = (body: unknown) => call('bind-egress-slot', body);

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ cookie, app } = await createSteppedUpGod(t.app, db));
    const dir = join(resolveExtensionsBase(), EXT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: EXT,
        permissions: ['data:system'],
        jobs: [{ name: 'ask', input: { type: 'object' }, egressSlots: ['provider'] }],
      }),
    );
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, true, false)`.execute(db);
  });

  afterAll(async () => {
    rmSync(join(resolveExtensionsBase(), EXT), { recursive: true, force: true });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
  });

  it('refuses while no consent is recorded: binding would end grandfathering', async () => {
    const res = await bind({ slot: 'provider', authorities: ['api.example.com'] });
    expect(res.status).toBe(409);
    expect(await readGranted(db, EXT)).toBeNull();
  });

  it('binds, rebinds and unbinds a declared slot; the approval keeps it', async () => {
    expect((await call('approve-capabilities', { capabilities: ['data:system'] })).status).toBe(
      200,
    );
    let res = await bind({ slot: 'provider', authorities: ['api.example.com'] });
    expect(res.status).toBe(200);
    expect(await readGranted(db, EXT)).toEqual(['data:system', 'egress:provider=api.example.com']);

    res = await bind({ slot: 'provider', authorities: ['localhost:11434'], private: true });
    expect(res.status).toBe(200);
    // Replaced, not added to: the old authority is gone.
    expect(await readGranted(db, EXT)).toEqual([
      'data:system',
      'egress:provider=localhost:11434;private',
    ]);

    // Approving capabilities again names only what is declared, and keeps the binding.
    expect((await call('approve-capabilities', { capabilities: [] })).status).toBe(200);
    expect(await readGranted(db, EXT)).toEqual(['egress:provider=localhost:11434;private']);

    res = await bind({ slot: 'provider', authorities: [] });
    expect(res.status).toBe(200);
    expect(await readGranted(db, EXT)).toEqual([]);

    const audit = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM zv_audit_log
      WHERE event_type = 'extension.egress.slot_bound' AND resource_id = ${EXT}
      ORDER BY created_at`.execute(db);
    expect(audit.rows.map((r) => r.metadata.binding)).toEqual([
      'egress:provider=api.example.com',
      'egress:provider=localhost:11434;private',
      null,
    ]);
  });

  it('refuses an undeclared slot, a host that is not one, and private with nothing bound', async () => {
    expect((await bind({ slot: 'other', authorities: ['a.example.com'] })).status).toBe(409);
    expect((await bind({ slot: 'provider', authorities: ['https://a.example.com'] })).status).toBe(
      400,
    );
    expect((await bind({ slot: 'provider', authorities: ['*.example.com'] })).status).toBe(400);
    expect((await bind({ slot: 'provider', authorities: [], private: true })).status).toBe(400);
    expect((await bind({ slot: 'provider', authorities: 'a.example.com' })).status).toBe(400);
  });

  it("refuses a tenant admin, stepped up: where an extension's network goes is the operator's", async () => {
    const admin = await createMemberSession(app, db, { configWindow: true });
    await (await getEnforcer()).addRoleForUser(admin.userId, 'admin', DEFAULT_TENANT_ID);
    const res = await call(
      'bind-egress-slot',
      { slot: 'provider', authorities: ['evil.example.com'] },
      admin.cookie,
      await admin.stepUp!(`extension.bind-egress-slot:${EXT}`),
    );
    expect(res.status).toBe(403);
    expect(await readGranted(db, EXT)).toEqual([]);
  });
});

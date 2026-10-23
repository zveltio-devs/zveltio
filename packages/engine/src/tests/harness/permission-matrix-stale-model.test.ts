/**
 * The permission matrix's bulk save leaves the table — and this replica's
 * model — holding exactly what was posted, even when the model is stale.
 *
 * `POST /api/admin/permissions/bulk` diffed the posted set against the in-memory
 * model (`getFilteredPolicy`) and wrote only the difference. On a replica whose
 * model is behind the table (another replica's change not yet heard over the
 * bus), a rule the model and the save agreed on was never written: a row only
 * the table held stayed granted although the operator unticked it, and a rule
 * only the model held was never inserted although the operator kept it ticked.
 * `GET /permissions` reads the table, so the screen showed the save undone, and
 * the next reconcile loaded the table back over the model.
 *
 * The save now diffs against both: it removes whatever the table OR the model
 * holds that was not posted, and adds whatever was posted that the table AND
 * the model do not both hold. The enforcer's single-rule writes reach the table
 * either way (`TableEnforcer`, casbin-stale-model-write.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer, reconcilePolicies } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ROLE = `pmstale_role_${tag}`;

d('the matrix save through a stale model', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let roleId: string;

  const rule = (res: string) => [ROLE, '*', `pmstale_${res}_${tag}`, 'read'];
  const inTable = async (r: string[]) =>
    (
      await sql`SELECT 1 FROM zvd_permissions
                 WHERE ptype = 'p' AND v0 = ${r[0]} AND v1 = ${r[1]} AND v2 = ${r[2]} AND v3 = ${r[3]}`.execute(
        db,
      )
    ).rows.length > 0;
  const inModel = async (r: string[]) => (await getEnforcer()).getModel().hasPolicy('p', 'p', r);
  const save = (rules: string[][]) =>
    app.request('/api/admin/permissions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        permissions: rules.map((r) => ({
          role_id: roleId,
          resource: r[2],
          action: r[3],
        })),
      }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: ROLE }),
    });
    expect(res.status).toBeLessThan(300);
    roleId = ((await res.json()) as { role: { id: string } }).role.id;
    await reconcilePolicies();
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE}`.execute(db);
    await db.deleteFrom('zv_roles').where('name', '=', ROLE).execute();
    await reconcilePolicies();
  });

  it('a rule only the table holds is removed when unticked and loaded when kept', async () => {
    // Another replica granted both; this model missed the messages.
    const dropped = rule('tdrop');
    const kept = rule('tkeep');
    for (const r of [dropped, kept]) {
      await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
                VALUES ('p', ${r[0]}, ${r[1]}, ${r[2]}, ${r[3]})`.execute(db);
      expect(await inModel(r)).toBe(false);
    }

    expect((await save([kept])).status).toBe(200);

    expect(await inTable(dropped)).toBe(false);
    expect(await inTable(kept)).toBe(true);
    expect(await inModel(kept)).toBe(true);
  });

  it('a rule only the model holds is written when kept and forgotten when unticked', async () => {
    // Another replica revoked both (rows gone); this model still holds them.
    const kept = rule('mkeep');
    const dropped = rule('mdrop');
    const e = await getEnforcer();
    for (const r of [kept, dropped]) {
      e.getModel().addPolicy('p', 'p', r);
      expect(await inTable(r)).toBe(false);
    }

    expect((await save([kept])).status).toBe(200);

    expect(await inTable(kept)).toBe(true);
    expect(await inModel(dropped)).toBe(false);
    expect(await inTable(dropped)).toBe(false);
  });

  it('two concurrent saves leave exactly one of the posted sets', async () => {
    // Each save reads the role's rows, then writes the difference: unlocked,
    // the second read could see neither save's writes, and the result was a
    // mix of both sets — rules neither operator posted together.
    const a = ['ca1', 'ca2', 'ca3', 'ca4'].map(rule);
    const b = ['cb1', 'cb2', 'cb3', 'cb4'].map(rule);
    expect((await save([a[0], b[0]])).status).toBe(200);

    const [ra, rb] = await Promise.all([save(a), save(b)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    const held = async (rs: string[][]) =>
      (await Promise.all(rs.map(inTable))).filter(Boolean).length;
    const counts = [await held(a), await held(b)].sort();
    expect(counts).toEqual([0, 4]);
  });
});

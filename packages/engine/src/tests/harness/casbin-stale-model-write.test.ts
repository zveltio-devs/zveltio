/**
 * A policy write through a replica whose model is behind the table still
 * reaches the table.
 *
 * Casbin's `addPolicy`/`removePolicy` (and the grouping variants under
 * `addRoleForUser`/`deleteRoleForUser`) return false WITHOUT calling the adapter
 * when the in-memory model already holds — or already lacks — the rule. On a
 * replica that has not yet heard another's change, an operator's grant or revoke
 * through it was dropped: a re-grant left the row (and the revocation) as the
 * other replica wrote them, a revoke left the row granted and recorded nothing,
 * and the next reconcile loaded the table back over what the operator did.
 *
 * Each test makes the model disagree with the table, exactly what a missed bus
 * message looks like, then writes through the enforcer and reads the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { realtimeBus, type RealtimeBusMessage } from '../../lib/runtime/index.js';
import { getEnforcer, reconcilePolicies } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

d('a write through a stale model', () => {
  let db: Database;
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  // A default grant (tenant_member read), so a revoke is recorded.
  const rule = ['tenant_member', '*', `sm_res_${tag}`, 'read'];
  const link = [`sm-u-${tag}`, `sm_role_${tag}`, TENANT];

  const held = async (ptype: 'p' | 'g', r: string[]) => {
    const { rows } = await sql`
      SELECT 1 FROM zvd_permissions
       WHERE ptype = ${ptype} AND v0 = ${r[0]} AND v1 = ${r[1]} AND v2 = ${r[2]}
         AND v3 IS NOT DISTINCT FROM ${r[3] ?? null}
    `.execute(db);
    return rows.length > 0;
  };
  const revoked = async () => {
    const { rows } = await sql`
      SELECT 1 FROM zv_default_grant_revocations
       WHERE role = ${rule[0]} AND resource = ${rule[2]} AND action = ${rule[3]}
    `.execute(db);
    return rows.length > 0;
  };
  const published = (r: string[]) =>
    sent.some((m) =>
      JSON.stringify((m.data as { rules?: string[][] }).rules ?? []).includes(r[0]!),
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    bus.publish = async (payload) => {
      sent.push(payload);
    };
    await reconcilePolicies();
  });

  afterAll(async () => {
    bus.publish = origPublish;
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`%${tag}%`} OR v2 LIKE ${`%${tag}%`}`.execute(
      db,
    );
    await sql`DELETE FROM zv_default_grant_revocations WHERE resource LIKE ${`%${tag}%`}`.execute(
      db,
    );
    await reconcilePolicies();
  });

  it('a revoke of a rule the model never heard of deletes the row and records it', async () => {
    // Another replica granted it; this model missed the message.
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
              VALUES ('p', ${rule[0]}, ${rule[1]}, ${rule[2]}, ${rule[3]})`.execute(db);
    const e = await getEnforcer();
    expect(e.getModel().hasPolicy('p', 'p', rule)).toBe(false);

    sent.length = 0;
    await e.removePolicy(...rule);

    expect(await held('p', rule)).toBe(false);
    expect(await revoked()).toBe(true);
    expect(published(rule)).toBe(true);
  });

  it('a re-grant of a rule the model still holds writes the row and clears the revocation', async () => {
    // Another replica revoked it (row gone, revocation recorded); this model
    // still holds it.
    const e = await getEnforcer();
    e.getModel().addPolicy('p', 'p', rule);
    expect(await held('p', rule)).toBe(false);
    expect(await revoked()).toBe(true);

    sent.length = 0;
    await e.addPolicy(...rule);

    expect(await held('p', rule)).toBe(true);
    expect(await revoked()).toBe(false);
    expect(published(rule)).toBe(true);
  });

  it('a role link goes the same way', async () => {
    const e = await getEnforcer();
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2)
              VALUES ('g', ${link[0]}, ${link[1]}, ${link[2]})`.execute(db);
    expect(e.getModel().hasPolicy('g', 'g', link)).toBe(false);
    await e.deleteRoleForUser(link[0]!, link[1]!, link[2]!);
    expect(await held('g', link)).toBe(false);

    e.getModel().addPolicy('g', 'g', link);
    await e.addRoleForUser(link[0]!, link[1]!, link[2]!);
    expect(await held('g', link)).toBe(true);
  });

  it('a write the table already agrees with tells nobody', async () => {
    const e = await getEnforcer();
    sent.length = 0;
    await e.addPolicy(...rule); // model and table both hold it
    await e.removePolicy(rule[0]!, rule[1]!, `sm_absent_${tag}`, 'read'); // neither does
    expect(sent).toHaveLength(0);
    expect(await held('p', rule)).toBe(true);
  });
});

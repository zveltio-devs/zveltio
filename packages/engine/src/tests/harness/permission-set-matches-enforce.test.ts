/**
 * The fast path is only allowed to exist while it agrees with the slow one.
 *
 * `checkPermission` answers from a set resolved once per (user, domain) instead
 * of scanning every policy per question. That is a rewrite of the authorization
 * decision, so the test that matters is not "is it fast" — it is "does it give
 * casbin's answer", asked over the policy table that is actually installed.
 *
 * The trap this guards against is real and was hit while writing it: casbin's
 * own `getImplicitPermissionsForUser` looks like the right tool and returns
 * ZERO permissions for a `tenant_admin` here, because the `p` rules carry
 * `dom = '*'` and that API filters by exact domain while the matcher honours the
 * wildcard. A permission set built on it would have denied everything.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { __allowViaSet, getEnforcer, reconcilePolicies } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

type Case = { subject: string; domain: string; resource: string; action: string };

/**
 * The oracle is `enforce()` over a model that holds exactly the table.
 *
 * The set is not built from the live model alone: for a user whose `member` row
 * the model has not heard of, it also reads that user's `g` rows from
 * `zvd_permissions` (`unloadedRoles` in lib/tenancy/permissions.ts, called from
 * `effectivePermissions`) — a user written by another replica, or straight to
 * the table, is answered by the table, which is the truth the model only
 * caches. `enforce()` reads the model and nothing else, so for such a user it
 * answered `false` where the product answers `true`, and agreed again only once
 * a reconcile loaded the row. Earlier harness files leave exactly such users
 * behind in the shared process (a direct `INSERT` of a `tenant_admin` row), and
 * a sample drawn from "whatever `LIMIT` returns" hit one in CI:
 * `inainte: true` against `inainte: false`. So the model is brought to the table
 * first; the table-only shape has its own case below, against `enforce()` after
 * the model caught up.
 *
 * `enforce()` over the subject AND its `"user".role`: the set counts the column
 * role as a `g <user> <role> *` row would, and the effect is `some(allow)`, so
 * the union is the two verdicts OR-ed.
 */
async function oracle(
  db: Database,
  e: Awaited<ReturnType<typeof getEnforcer>>,
  c: Case,
): Promise<boolean> {
  if (await e.enforce(c.subject, c.domain, c.resource, c.action)) return true;
  const row = await sql<{ role: string }>`
    SELECT role FROM "user" WHERE id = ${c.subject}
  `.execute(db);
  const role = row.rows[0]?.role;
  return role !== undefined && (await e.enforce(role, c.domain, c.resource, c.action));
}

d('resolved permission set matches enforce()', () => {
  let db: Database;
  const cases: Case[] = [];

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // See `oracle`: without this, the oracle is a stale model, not casbin.
    await reconcilePolicies();

    // Real subjects and domains, straight out of the installed policy table.
    const grants = await sql<{ v0: string; v2: string }>`
      SELECT DISTINCT v0, v2 FROM zvd_permissions WHERE ptype = 'g' ORDER BY v0, v2 LIMIT 8
    `.execute(db);
    const objects = await sql<{ v2: string; v3: string }>`
      SELECT DISTINCT v2, v3 FROM zvd_permissions WHERE ptype = 'p' ORDER BY v2, v3 LIMIT 6
    `.execute(db);

    for (const g of grants.rows) {
      for (const o of objects.rows) {
        // The granted shape, and the same object with an action nobody granted.
        cases.push({ subject: g.v0, domain: g.v2, resource: o.v2, action: o.v3 });
        cases.push({ subject: g.v0, domain: g.v2, resource: o.v2, action: 'zz_no_such_action' });
      }
      // A name no policy mentions, and a domain the subject has nothing in.
      cases.push({ subject: g.v0, domain: g.v2, resource: 'zz_unnamed_resource', action: 'read' });
      cases.push({
        subject: g.v0,
        domain: '00000000-0000-0000-0000-0000000000zz'.replace('zz', 'ff'),
        resource: objects.rows[0]?.v2 ?? 'collections',
        action: 'read',
      });
    }
    // Shapes that SHOULD be allowed: a subject's role joined to a policy of that
    // role. The pairs above cross unrelated grants and objects, so whether any of
    // them is allowed depended on which rows `LIMIT` happened to return — and
    // `allowed > 0` below failed on a docs-only change. `enforce()` still decides;
    // this only makes sure the sample holds something for it to allow. First in
    // the list, because the budget below keeps a prefix.
    const held = await sql<Case>`
      SELECT DISTINCT g.v0 AS subject, g.v2 AS domain, p.v2 AS resource, p.v3 AS action
        FROM zvd_permissions g
        JOIN zvd_permissions p
          ON p.ptype = 'p' AND p.v0 = g.v1 AND (p.v1 = '*' OR p.v1 = g.v2)
       WHERE g.ptype = 'g'
       ORDER BY 1, 2, 3, 4
       LIMIT 4
    `.execute(db);
    cases.unshift(...held.rows);
    // A user allowed only through the column role (a `p member` rule, no `g` row).
    const viaColumn = await sql<Case>`
      SELECT u.id AS subject, '*' AS domain, p.v2 AS resource, p.v3 AS action
        FROM "user" u
        JOIN zvd_permissions p ON p.ptype = 'p' AND p.v0 = u.role AND p.v1 = '*'
       WHERE u.role = 'member'
       ORDER BY 1, 3, 4
       LIMIT 1
    `.execute(db);
    cases.unshift(...viaColumn.rows);

    // A subject with no grants at all — the expensive denial, and the common one.
    cases.push({
      subject: 'zz-subject-that-does-not-exist',
      domain: grants.rows[0]?.v2 ?? '*',
      resource: objects.rows[0]?.v2 ?? 'collections',
      action: 'read',
    });
  });

  it('has real policy data to compare against', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it('agrees with enforce() on every case, allow and deny alike', async () => {
    const e = await getEnforcer();
    const disagreements: string[] = [];
    let allowed = 0;

    // The oracle is priced per policy; the sample is sized to fit.
    //
    // `enforce()` walks the policy table until something matches, so a DENIAL
    // reads all of it. That is exactly why the product stopped calling it — the
    // hot path answers from a resolved Set (`effectivePermissions`) instead, and
    // this test exists to prove the two agree. But the oracle kept the old cost,
    // and it grows with the install:
    //
    //     870 policies   →    5.39 ms per enforce()
    //   31 084 policies  → 1 270 ms per enforce()
    //
    // (The path that actually serves requests went 0.07 ms → 1.50 ms over the
    // same range, which is the number that matters and is fine.)
    //
    // At the larger size the full case list costs ~143 s and the test failed on
    // its own 120 s budget — on a database whose only sin was having as many
    // collections as a real install. A timeout here reads as an authorization
    // regression, which is the most expensive kind of false alarm on this path.
    //
    // So: time one call, then compare as many cases as fit the budget. The case
    // list was already a sample (`LIMIT 8`, `LIMIT 6`); this makes the sample
    // honest about what it can afford instead of pretending the oracle is cheap.
    // The probe asks the EXPENSIVE question, deliberately.
    //
    // `enforce()` stops at the first matching policy, so an allowed case is
    // cheap and a denial reads the whole table. A first version of this timed
    // `cases[0]` — a granted shape — measured 1 157 ms, sized the sample to 51,
    // and then took 2 670 ms per case on the real mix and blew the timeout
    // anyway. Sizing a budget from the cheap direction is not a measurement.
    // `zz_no_such_action` matches nothing, so this is the worst case by
    // construction and the estimate is an upper bound.
    const probe = cases[0]!;
    const probeStart = Bun.nanoseconds();
    await e.enforce(probe.subject, probe.domain, probe.resource, 'zz_no_such_action');
    const msPerCall = (Bun.nanoseconds() - probeStart) / 1e6;
    const budgetMs = 30_000;
    const affordable = Math.max(10, Math.floor(budgetMs / Math.max(msPerCall, 0.01)));
    const sample = cases.slice(0, Math.min(cases.length, affordable));
    if (sample.length < cases.length) {
      console.warn(
        `[permission-set] oracle costs ${msPerCall.toFixed(1)} ms/call at this policy size; ` +
          `comparing ${sample.length}/${cases.length} cases within the ${budgetMs / 1000}s budget`,
      );
    }

    for (const c of sample) {
      const slow = await oracle(db, e, c);
      const fast = await __allowViaSet(c.subject, c.domain, c.resource, c.action);
      if (slow) allowed++;
      if (slow !== fast) {
        disagreements.push(
          `${c.subject.slice(0, 12)} | ${c.domain.slice(0, 12)} | ${c.resource} | ${c.action} — enforce=${slow} set=${fast}`,
        );
      }
    }

    expect(disagreements).toEqual([]);
    // A run where everything is denied would agree trivially and prove nothing.
    expect(allowed).toBeGreaterThan(0);
    // And a sample small enough to prove nothing is not a pass either.
    expect(sample.length).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('agrees after a grant is added and again after it is removed', async () => {
    const e = await getEnforcer();
    // A subject of its own, holding the baseline role through the enforcer, so
    // model and table agree on it and every verdict below is known. It used to
    // be the first `g` row of the table — whoever an earlier file left there —
    // and the case could only assert agreement, which a subject that answers
    // `true` to everything satisfies without the grant ever mattering.
    const subject = `equiv_user_${Date.now()}`;
    const domain = '*';
    const resource = `equiv_${Date.now()}`;
    await e.addRoleForUser(subject, 'member', domain);

    const agree = async (label: string) => {
      const slow = await oracle(db, e, { subject, domain, resource, action: 'read' });
      const fast = await __allowViaSet(subject, domain, resource, 'read');
      expect(`${label}: ${fast}`).toBe(`${label}: ${slow}`);
      return fast;
    };

    try {
      // Resolved and memoized here, so the two below prove the writes drop it.
      expect(await agree('inainte')).toBe(false);
      await e.addPolicy(subject, domain, resource, 'read');
      try {
        expect(await agree('cu grant')).toBe(true);
      } finally {
        await e.removePolicy(subject, domain, resource, 'read');
      }
      expect(await agree('dupa retragere')).toBe(false);
    } finally {
      await e.deleteRoleForUser(subject, 'member', domain);
    }
  }, 60_000);

  // The shape that disagreed in CI, pinned: a user whose roles are in the table
  // and not yet in this model (another replica wrote them). The set answers
  // from the table at once; it must answer what casbin answers once the model
  // has loaded the same rows — in that tenant, and in no other.
  it('a role only the table holds answers as casbin does after the model loads it', async () => {
    const id = `equiv_table_${Date.now()}`;
    const tenantA = '00000000-0000-4000-8000-0000000000c1';
    const tenantB = '00000000-0000-4000-8000-0000000000c2';
    const resource = `equiv_res_${Date.now()}`;
    // The account trigger writes its `member` row to the table only (migration 059).
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${id}, 'equiv', ${`${id}@test.local`}, false, 'member', NOW(), NOW())
    `.execute(db);
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${id}, 'tenant_admin', ${tenantA})
    `.execute(db);
    try {
      const fastA = await __allowViaSet(id, tenantA, resource, 'read');
      const fastB = await __allowViaSet(id, tenantB, resource, 'read');
      expect([fastA, fastB]).toEqual([true, false]);

      expect(await reconcilePolicies()).toBe(true);
      const e = await getEnforcer();
      expect(e.getModel().hasPolicy('g', 'g', [id, 'tenant_admin', tenantA])).toBe(true);
      const slowA = await oracle(db, e, { subject: id, domain: tenantA, resource, action: 'read' });
      const slowB = await oracle(db, e, { subject: id, domain: tenantB, resource, action: 'read' });
      expect([slowA, slowB]).toEqual([fastA, fastB]);
    } finally {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${id}`.execute(db);
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db);
      await reconcilePolicies();
    }
  }, 60_000);

  // The sampled cases above come from whatever rows `LIMIT` returns, and on a
  // fresh install every `p` row sits in domain `*` — so a set that ignored the
  // policy's domain, or widened `read` to every action, agreed with enforce() on
  // all of them. A grant in one tenant must not answer for another.
  it('a grant in one tenant answers for that tenant and that action only', async () => {
    const e = await getEnforcer();
    const subject = `equiv_sub_${Date.now()}`;
    const resource = `equiv_res_${Date.now()}`;
    const tenantA = '00000000-0000-4000-8000-0000000000a1';
    const tenantB = '00000000-0000-4000-8000-0000000000b2';
    const verdict = async (domain: string, action: string) => {
      const slow = await e.enforce(subject, domain, resource, action);
      const fast = await __allowViaSet(subject, domain, resource, action);
      expect(`${domain}/${action}: ${fast}`).toBe(`${domain}/${action}: ${slow}`);
      return fast;
    };
    await e.addPolicy(subject, tenantA, resource, 'read');
    try {
      expect(await verdict(tenantA, 'read')).toBe(true);
      expect(await verdict(tenantB, 'read')).toBe(false);
      expect(await verdict(tenantA, 'update')).toBe(false);
    } finally {
      await e.removePolicy(subject, tenantA, resource, 'read');
    }
  }, 60_000);
});

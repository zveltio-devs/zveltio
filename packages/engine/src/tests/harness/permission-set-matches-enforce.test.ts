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
import { __allowViaSet, getEnforcer } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

type Case = { subject: string; domain: string; resource: string; action: string };

d('resolved permission set matches enforce()', () => {
  let db: Database;
  const cases: Case[] = [];

  beforeAll(async () => {
    ({ db } = await getTestApp());

    // Real subjects and domains, straight out of the installed policy table.
    const grants = await sql<{ v0: string; v2: string }>`
      SELECT DISTINCT v0, v2 FROM zvd_permissions WHERE ptype = 'g' LIMIT 8
    `.execute(db);
    const objects = await sql<{ v2: string; v3: string }>`
      SELECT DISTINCT v2, v3 FROM zvd_permissions WHERE ptype = 'p' LIMIT 6
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

    for (const c of cases) {
      const slow = await e.enforce(c.subject, c.domain, c.resource, c.action);
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
  }, 120_000);

  it('agrees after a grant is added and again after it is removed', async () => {
    const e = await getEnforcer();
    const grants = await sql<{ v0: string; v2: string }>`
      SELECT v0, v2 FROM zvd_permissions WHERE ptype = 'g' LIMIT 1
    `.execute(db);
    const subject = grants.rows[0]!.v0;
    const domain = grants.rows[0]!.v2;
    const resource = `equiv_${Date.now()}`;

    // Agreement is the property under test, not any particular verdict. The
    // subject here may well be a `tenant_admin`, and `('*','*','*')` means every
    // question about them answers `true` — including after the specific grant is
    // taken away. Asserting `false` there would be testing the fixture, not the
    // code, and it is exactly the wrong assumption this test made first.
    const agree = async (label: string) => {
      const slow = await e.enforce(subject, domain, resource, 'read');
      const fast = await __allowViaSet(subject, domain, resource, 'read');
      expect(`${label}: ${fast}`).toBe(`${label}: ${slow}`);
      return slow;
    };

    await agree('inainte');
    await e.addPolicy(subject, domain, resource, 'read');
    try {
      expect(await agree('cu grant')).toBe(true);
    } finally {
      await e.removePolicy(subject, domain, resource, 'read');
    }
    await agree('dupa retragere');
  }, 60_000);
});

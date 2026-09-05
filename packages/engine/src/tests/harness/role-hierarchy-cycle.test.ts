/**
 * The role-inheritance guard has to refuse a loop of any length.
 *
 * `POST /api/admin/roles/hierarchy` refuses circular inheritance by asking for
 * the parent's roles. It used to ask for the DIRECT ones, which catches
 * `A inherits B` followed by `B inherits A` and nothing longer. Measured: with
 * A→B and B→C already in place, closing the loop with C→A was allowed, and
 * casbin then resolved A's implicit roles as [B, C, A].
 *
 * The consequence is not a crash — casbin walks a cycle without looping. It is
 * that every role in the loop silently acquires every other role's permissions,
 * while the inheritance tree the administrator reads shows three ordinary edges
 * and says nothing about the loop they close. On a screen whose entire job is to
 * make authorization legible, that is the failure.
 */

import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('role hierarchy cycles (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const tag = crypto.randomUUID().slice(0, 8);
  const A = `cyc-a-${tag}`;
  const B = `cyc-b-${tag}`;
  const C = `cyc-c-${tag}`;
  const D = `cyc-d-${tag}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`
      DELETE FROM zvd_permissions
       WHERE v0 IN (${A}, ${B}, ${C}, ${D}) OR v1 IN (${A}, ${B}, ${C}, ${D})
    `.execute(db);
  });

  const link = (child: string, parent: string) =>
    app.request('/api/admin/roles/hierarchy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ child, parent }),
    });

  it('refuses a loop three roles long', async () => {
    expect((await link(A, B)).status).toBe(200);
    expect((await link(B, C)).status).toBe(200);

    // A → B → C, and this edge would close the ring.
    const closing = await link(C, A);
    expect(closing.status).toBe(409);
  });

  it('still allows an edge that closes nothing', async () => {
    // The guard must refuse loops, not inheritance. D sits below A and the
    // chain stays acyclic, so this has to keep working.
    expect((await link(D, A)).status).toBe(200);
  });

  it('still refuses the direct two-role loop it always caught', async () => {
    const res = await link(B, A);
    expect(res.status).toBe(409);
  });
});

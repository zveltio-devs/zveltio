/**
 * `zv_invitations.tenant_id` references `zv_tenants` (A10, migration 076).
 *
 * The column named a tenant with no foreign key, so an invitation could be
 * written for a tenant that does not exist and a bare tenant delete left its
 * invitations behind. On a fresh database no orphan exists, so the key must
 * come out validated.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('zv_invitations.tenant_id foreign key', () => {
  it('is validated and cascades from zv_tenants', async () => {
    const { db } = await getTestApp();
    const fk = await sql<{ convalidated: boolean; confdeltype: string }>`
      SELECT convalidated, confdeltype FROM pg_constraint
       WHERE conname = 'zv_invitations_tenant_id_fkey'`.execute(db);
    expect(fk.rows[0]).toEqual({ convalidated: true, confdeltype: 'c' });
  });
});

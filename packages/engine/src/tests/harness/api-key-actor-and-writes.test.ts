/**
 * Two things an audit found switched off, pinned so they cannot switch off again.
 *
 * 1. API-key traffic reached the row-rule policies with NO identity. The tenant
 *    middleware publishes the actor for sessions, before the transaction opens;
 *    a key is not known then, because it is resolved inside the handler. So
 *    every rule read an empty setting and skipped itself. The engine still
 *    restricted such a request — this was never a leak — but the second layer
 *    was off for a whole class of traffic, which is what the second layer is for.
 *
 * 2. A RESTRICTIVE policy with no `WITH CHECK` uses its read predicate for
 *    writes. That behaviour is right — a caller should not create a row they
 *    could not see — but it was inherited from the Postgres manual rather than
 *    written down, and the refusal came back as a message about tenancy, so a
 *    developer refused by a row rule went looking in the wrong place.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  applyRowRulePolicy,
  publishApiKeyActor,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { authenticate } from '../../lib/data/auth.js';
import { describeWriteRefusal, isRlsRefusal } from '../../lib/data/write-pipeline.js';
import { hashApiKey } from '../../lib/security/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `keyactor_${STAMP}`;
const TABLE = `zvd_${COLL}`;

d('API keys and writes meet the same rules (in-process)', () => {
  let db: Database;
  let tenant = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;

    await sql.raw(`
      CREATE TABLE ${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        title text NOT NULL,
        created_by text
      )
    `).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql
      .raw(
        `CREATE POLICY tenant_isolation ON ${TABLE} ` +
          `USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))`,
      )
      .execute(db);
    await sql.raw(`GRANT SELECT, INSERT, UPDATE ON ${TABLE} TO zveltio_rls`).execute(db);
    await sql.raw(`
      INSERT INTO ${TABLE} (tenant_id, title, created_by) VALUES
        ('${tenant}', 'mine',    'apikey:k1'),
        ('${tenant}', 'someone', 'user-9')
    `).execute(db);

    await sql`
      INSERT INTO zvd_collections (name, display_name) VALUES (${COLL}, ${COLL})
      ON CONFLICT DO NOTHING
    `.execute(db).catch(() => {});
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLL}, '*', 'created_by', 'eq', 'user_id', true)
    `.execute(db);
    await applyRowRulePolicy(db, COLL);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLL}`.execute(db).catch(() => {});
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db).catch(() => {});
    await sql`DELETE FROM zvd_collections WHERE name = ${COLL}`.execute(db).catch(() => {});
  });

  it('a key with no exemption is held to the rule, like a session', async () => {
    const titles = await withTenantIsolation(
      tenant,
      async (trx) => {
        await publishApiKeyActor('apikey:k1', false);
        const r = await sql.raw<{ title: string }>(`SELECT title FROM ${TABLE} ORDER BY title`)
          .execute(trx);
        return r.rows.map((x) => x.title);
      },
      { userId: null },
    );
    // Only the row this key created. Before this, the policy saw no identity and
    // skipped the rule, so both rows came back.
    expect(titles).toEqual(['mine']);
  });

  it('an exempt key still sees everything', async () => {
    const titles = await withTenantIsolation(
      tenant,
      async (trx) => {
        await publishApiKeyActor('apikey:k1', true);
        const r = await sql.raw<{ title: string }>(`SELECT title FROM ${TABLE} ORDER BY title`)
          .execute(trx);
        return r.rows.map((x) => x.title);
      },
      { userId: null },
    );
    expect(titles).toEqual(['mine', 'someone']);
  });

  it('refuses a write into a shape the caller could not read', async () => {
    // The rule restricts reading to your own rows, so it restricts writing into
    // someone else's. Explicit in the generated policy now, rather than inherited.
    let refusal: unknown = null;
    await withTenantIsolation(
      tenant,
      async (trx) => {
        await publishApiKeyActor('apikey:k1', false);
        try {
          await sql
            .raw(
              `INSERT INTO ${TABLE} (tenant_id, title, created_by) ` +
                `VALUES ('${tenant}', 'planted', 'somebody-else')`,
            )
            .execute(trx);
        } catch (err) {
          refusal = err;
        }
      },
      { userId: null },
    );
    expect(refusal).not.toBeNull();
    expect(isRlsRefusal(refusal)).toBe(true);
  });

  it('says which boundary refused, and where the rules live', async () => {
    // The old message named only tenancy, so a developer refused by a row rule
    // went looking at the wrong layer.
    const said = describeWriteRefusal('new row violates row-level security policy for table "x"');
    expect(said).toContain('another tenant');
    expect(said).toContain('row rule');
    expect(said).toContain('/api/admin/rls');
  });
  it('the real authentication path publishes it, not just this test', async () => {
    // The four cases above call `publishApiKeyActor` by hand, so they prove the
    // mechanism and nothing about whether anything uses it. This drives
    // `authenticate()` — the one place a key is resolved — and then reads the
    // table with no filter of its own, so the only thing that can narrow the
    // answer is the policy.
    const raw = `zvk_${STAMP}_wiring`;
    const keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id)
        VALUES ('wiring probe', ${await hashApiKey(raw)}, 'zvk_', '[]'::jsonb, 100, true, ${tenant}::uuid)
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;

    // Enough of a Hono context for this path: no session, the key in the header.
    const ctx = {
      get: (k: string) => (k === 'prefetchedSession' ? null : null),
      req: { header: (h: string) => (h === 'X-API-Key' ? raw : undefined), raw: { headers: new Headers() } },
    };

    try {
      const seen = await withTenantIsolation(
        tenant,
        async (trx) => {
          const who = await authenticate(ctx as never, {} as never, db);
          expect(who?.authType).toBe('api_key');
          expect(who?.user.id).toBe(`apikey:${keyId}`);
          const r = await sql.raw<{ title: string }>(`SELECT title FROM ${TABLE} ORDER BY title`)
            .execute(trx);
          return r.rows.map((x) => x.title);
        },
        { userId: null },
      );
      // This key created nothing, so the rule leaves it nothing. Before the fix
      // the same request saw both rows, because the policy read an empty
      // identity and skipped itself.
      expect(seen).toEqual([]);
    } finally {
      await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    }
  });
});

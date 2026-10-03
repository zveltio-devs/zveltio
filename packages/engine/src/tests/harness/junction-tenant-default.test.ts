/**
 * A junction link written between migration and reconcile keeps its tenant.
 *
 * 042 gave existing m2m junctions a bare `tenant_id` and left its default to the
 * boot reconciler. A link inserted in that window — a replica of the previous
 * release during a rolling upgrade, or any replica after `zveltio migrate` ran
 * ahead of the new binary — got NULL, and `applyTenantRLS` then backfilled it to
 * the default tenant. 051 sets the default in the same runner pass.
 *
 * Runs, as the runner would, every migration from 042 on that touches junctions,
 * then inserts a link the way a tenant request does, with no reconcile between.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const DIR = new URL('../../db/migrations/sql/', import.meta.url);
const STAMP = Date.now().toString(36);
const SRC = `zvd_jds_${STAMP}`;
const TGT = `zvd_jdt_${STAMP}`;
const J = `zvd_jnc_jds_${STAMP}_jdt_${STAMP}`;

d('junction tenant_id default before the reconciler runs', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('a link inserted in a tenant transaction lands on that tenant', async () => {
    const ups: string[] = [];
    for (const f of readdirSync(DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 42)
      .sort()) {
      const { up } = parseMigrationFile(await Bun.file(new URL(f, DIR)).text());
      if (up.includes('zvd\\_jnc\\_')) ups.push(up);
    }

    const other = crypto.randomUUID();
    const rollback = new Error('rollback');
    let tenant: string | null | undefined;
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${other}, ${`jd-${STAMP}`}, 'jd')`.execute(
          trx,
        );
        for (const t of [SRC, TGT]) {
          await sql
            .raw(`CREATE TABLE ${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                           tenant_id uuid NOT NULL)`)
            .execute(trx);
        }
        // The shape an engine before 042 created: no tenant_id.
        await sql
          .raw(`CREATE TABLE ${J} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                         s uuid REFERENCES ${SRC}(id), t uuid REFERENCES ${TGT}(id),
                         created_at timestamptz NOT NULL DEFAULT now())`)
          .execute(trx);
        for (const up of ups) {
          for (const stmt of splitSqlStatements(up)) await sql.raw(stmt).execute(trx);
        }
        // What a request of `other` does: its tenant published, no tenant_id named.
        await sql`SELECT set_config('zveltio.current_tenant', ${other}, true)`.execute(trx);
        await sql.raw(`INSERT INTO ${J} (s, t) VALUES (NULL, NULL)`).execute(trx);
        await sql`SELECT set_config('zveltio.current_tenant', '', true)`.execute(trx);
        tenant = (
          await sql<{ t: string | null }>`SELECT tenant_id::text AS t FROM ${sql.id(J)}`.execute(
            trx,
          )
        ).rows[0]?.t;
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(tenant).toBe(other);
  }, 60_000);
});

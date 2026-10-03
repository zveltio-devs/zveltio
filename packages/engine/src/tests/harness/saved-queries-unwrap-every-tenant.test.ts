/**
 * The jsonb-string repair of `zv_saved_queries.config` reaches every tenant.
 *
 * 039 ran its UPDATE with no tenant published, and the table is under FORCE RLS
 * (004). A plain role — what a hardened install migrates as — saw the default
 * tenant's rows only, so every other tenant's saved queries stayed jsonb strings
 * and 039 was recorded as applied. 049 repeats the repair one tenant at a time.
 *
 * Runs every migration from 039 on that touches the table, in order, as the
 * runner would, under a plain role bound by the policy.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const DIR = new URL('../../db/migrations/sql/', import.meta.url);
const ROOT = '00000000-0000-0000-0000-000000000001';
const STAMP = `squ${Date.now().toString(36)}`;

d('saved-query config repair, every tenant', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('a plain role unwraps every tenant’s rows and skips one that does not parse', async () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 39)
      .sort();
    const ups: string[] = [];
    for (const f of files) {
      const { up } = parseMigrationFile(await Bun.file(new URL(f, DIR)).text());
      if (up.includes('zv_saved_queries')) ups.push(up);
    }

    const other = crypto.randomUUID();
    const rollback = new Error('rollback');
    let rows: string[] = [];
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${other}, ${STAMP}, 'squ')`.execute(
          trx,
        );
        for (const [tenant, name, text] of [
          [ROOT, `${STAMP}-root`, '{"filter":{"a":1}}'],
          [other, `${STAMP}-other`, '{"filter":{"b":2}}'],
          [other, `${STAMP}-bad`, '{not json'],
        ]) {
          await sql`INSERT INTO zv_saved_queries (name, collection, config, tenant_id)
                    VALUES (${name}, 'c', to_jsonb(${text}::text), ${tenant}::uuid)`.execute(trx);
        }
        for (const up of ups) {
          for (const stmt of splitSqlStatements(up)) {
            // The engine role holds TEMPORARY (bootstrap-db-role.sh grants it);
            // zveltio_rls does not, so 039's pg_temp helper is made by the
            // connecting role. Every statement that reads a policed row runs
            // as the plain role.
            const asOwner = /pg_temp\.zv_unwrap\(t text\)/.test(stmt);
            await sql.raw(asOwner ? 'RESET ROLE' : 'SET LOCAL ROLE zveltio_rls').execute(trx);
            await sql.raw(stmt).execute(trx);
          }
        }
        await sql.raw('RESET ROLE').execute(trx);
        rows = (
          await sql<{ k: string }>`
            SELECT name || '=' || jsonb_typeof(config) AS k FROM zv_saved_queries
             WHERE name LIKE ${`${STAMP}-%`} ORDER BY 1`.execute(trx)
        ).rows.map((r) => r.k);
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(rows).toEqual([`${STAMP}-bad=string`, `${STAMP}-other=object`, `${STAMP}-root=object`]);
  }, 60_000);
});

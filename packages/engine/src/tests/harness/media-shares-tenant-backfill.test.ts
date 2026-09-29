/**
 * A share link gets the firm of what it shares, including the links 023 missed.
 *
 * 023 copied each file's `tenant_id` onto its shares before moving NULL-tenant
 * files and folders to the default tenant, so the shares of exactly those kept
 * a NULL firm. `/share/:token` enters the share's firm to read the file; with
 * NULL it reads with no tenant at all. Migration 031 fills them in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { rollbackMigration, runPending } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const STAMP = `msb-${Date.now()}`;

d('media shares carry the firm of what they share', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO "user" (id, name, email) VALUES (${STAMP}, ${STAMP}, ${`${STAMP}@test.local`})`.execute(
      db,
    );
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${STAMP}, ${STAMP}, 'active')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_media_shares WHERE token LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_media_files WHERE filename = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_media_folders WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${STAMP}`.execute(db);
  });

  it('a share left with a NULL firm gets its file or folder firm on migrate', async () => {
    const share = async (tenant: string, kind: 'file' | 'folder') => {
      const item =
        kind === 'file'
          ? await sql<{ id: string }>`
              INSERT INTO zv_media_files (filename, original_name, mimetype, storage_path, tenant_id)
              VALUES (${STAMP}, ${STAMP}, 'text/plain', ${`harness/${STAMP}`}, ${tenant}::uuid)
              RETURNING id::text AS id`.execute(db)
          : await sql<{ id: string }>`
              INSERT INTO zv_media_folders (name, tenant_id) VALUES (${STAMP}, ${tenant}::uuid)
              RETURNING id::text AS id`.execute(db);
      // What 023 left: a share of a formerly NULL-tenant file, firm NULL.
      await sql`
        INSERT INTO zv_media_shares (file_id, folder_id, token, created_by, tenant_id)
        VALUES (${kind === 'file' ? item.rows[0]!.id : null}::uuid,
                ${kind === 'folder' ? item.rows[0]!.id : null}::uuid,
                ${`${STAMP}-${tenant}-${kind}`}, ${STAMP}, NULL)`.execute(db);
    };
    await share(ROOT, 'file');
    await share(ROOT, 'folder');
    await share(OTHER, 'file');

    await rollbackMigration(db, 30);
    await runPending(db);

    const rows = await sql<{ token: string; tenant_id: string | null }>`
      SELECT token, tenant_id::text AS tenant_id FROM zv_media_shares
       WHERE token LIKE ${`${STAMP}%`} ORDER BY token`.execute(db);
    expect(Object.fromEntries(rows.rows.map((r) => [r.token, r.tenant_id]))).toEqual({
      [`${STAMP}-${ROOT}-file`]: ROOT,
      [`${STAMP}-${ROOT}-folder`]: ROOT,
      [`${STAMP}-${OTHER}-file`]: OTHER,
    });
  }, 120_000);
});

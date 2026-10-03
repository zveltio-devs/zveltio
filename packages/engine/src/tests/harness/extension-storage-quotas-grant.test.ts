import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
} from '../../lib/extensions/ext-db-role.js';
import {
  ExtensionSecurityError,
  createRestrictedDb,
} from '../../lib/extensions/extension-context.js';
import { buildAllowedTables } from '../../lib/extensions/register.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

/**
 * `zv_storage_quotas` had three creators — the engine's 001 and both media
 * extensions' 001 — and whichever ran first won. The engine always runs first,
 * so the extensions' richer shape (PK on `id`, UNIQUE keys, the CHECK) never
 * applied anywhere: measured against live PostgreSQL 18, both extension
 * orders converge on the engine shape plus the extensions' own ALTERs.
 *
 * The repair gave the table ONE creator — the engine, whose core upload path
 * reads it in `checkStorageQuota` — and removed the redeclaring CREATEs from
 * `content/media` and `storage/cloud`. Their access now stands on the
 * `EXTENSION_TABLE_GRANTS` entry alone: nothing in their migrations adds the
 * table to the allowlist anymore.
 *
 * This proves that access through the REAL `createRestrictedDb` against a
 * real database, with `zv_api_keys` as the positive control — a table the
 * same extensions must still be refused, so the test discriminates.
 */
const d = harnessAvailable() ? describe : describe.skip;

d('storage quota grant after the single-creator repair', () => {
  // The grant step turns the extension role on; do not leave it on for later files.
  afterAll(() => _resetExtensionDbRoleForTests());

  for (const ext of ['storage/cloud', 'content/media']) {
    it(`${ext} reaches zv_storage_quotas on its grant alone, and is still refused zv_api_keys`, async () => {
      const { db } = await getTestApp();

      // No migration paths on purpose: the extension no longer CREATEs the
      // table, so if the grant stops landing, nothing else hides it.
      const allowed = await buildAllowedTables([], ext);
      expect(allowed.has('zv_storage_quotas')).toBe(true);

      // What load.ts does after migrations: the grant lands as a privilege of the
      // role ctx.db runs as, not only in the analyzer's allowlist.
      await grantExtensionDbRole(db, ext, allowed);
      const priv = await sql<{ ok: boolean }>`
        SELECT has_table_privilege('zveltio_ext', 'zv_storage_quotas', 'SELECT') AS ok`.execute(db);
      expect(priv.rows[0]!.ok).toBe(true);

      const rdb = createRestrictedDb(db, ext, allowed);
      const rows = await rdb
        .selectFrom('zv_storage_quotas' as never)
        .selectAll()
        .execute();
      expect(Array.isArray(rows)).toBe(true);

      await expect(
        rdb
          .selectFrom('zv_api_keys' as never)
          .selectAll()
          .execute(),
      ).rejects.toBeInstanceOf(ExtensionSecurityError);
    });
  }
});

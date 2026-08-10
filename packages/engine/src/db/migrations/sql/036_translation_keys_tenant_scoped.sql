-- `zvd_translation_keys.key` is unique per company, not per instance.
--
-- Part of the sweep that widened sixty unique keys written before multi-tenancy
-- (see the companion pass in zveltio-extensions). This one lands in the engine
-- rather than in `i18n/translations` because the engine creates the table, in
-- 001_initial.sql. The extension's own `CREATE TABLE IF NOT EXISTS` never runs:
-- the engine's migrations go first, so the row is already there.
--
-- That ownership detail is exactly what the gate caught. The sweep surveyed a
-- database with every extension installed, where the extension appears to own
-- everything it declares, and put the fix there. On an engine-only database —
-- which is what the harness lane runs — nothing widened it, and
-- `unique-keys-tenant-scoped.test.ts` failed naming this table.
--
-- Widening a unique key is strictly more permissive, so no existing installation
-- can fail to migrate.

UPDATE zvd_translation_keys
   SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zvd_translation_keys
  DROP CONSTRAINT IF EXISTS zvd_translation_keys_key_key;

ALTER TABLE zvd_translation_keys
  ADD CONSTRAINT zvd_translation_keys_key_key UNIQUE (tenant_id, key);

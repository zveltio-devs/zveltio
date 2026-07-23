-- 020_translation_keys_missing_cols.sql
--
-- Schema drift repair. routes/translations.ts (POST /) writes `is_pluralized`
-- and `max_length`, and schema.generated.ts declares both — but no migration
-- ever created them on zvd_translation_keys, so a FRESH install 500s on every
-- translation-key creation ("column is_pluralized does not exist"). Long-lived
-- databases happened to have the columns from a since-removed migration, which
-- masked the bug until a from-scratch DB (CI) hit it.
--
-- Additive + idempotent: existing databases already have the columns (no-op),
-- fresh ones get them. Mirrors the columns the code and generated types expect.

ALTER TABLE zvd_translation_keys ADD COLUMN IF NOT EXISTS max_length     INTEGER;
ALTER TABLE zvd_translation_keys ADD COLUMN IF NOT EXISTS is_pluralized  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_translation_keys ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
ALTER TABLE zvd_translation_keys
  ADD COLUMN IF NOT EXISTS tenant_id UUID
  DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;

-- zvd_translations has the same drift: routes/translations.ts approve/set paths
-- write updated_at / approved_by / approved_at / char_count, all declared in
-- schema.generated.ts but never migrated onto a fresh DB.
ALTER TABLE zvd_translations ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE zvd_translations ADD COLUMN IF NOT EXISTS char_count  INTEGER;
ALTER TABLE zvd_translations ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE zvd_translations ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE zvd_translations
  ADD COLUMN IF NOT EXISTS tenant_id UUID
  DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;

-- Migration: 003_translation_glossary
--
-- Adds the missing `zvd_translation_glossary` table.
--
-- The /api/translations/glossary GET/POST routes referenced this table
-- but no migration ever created it. Calls would fail at runtime with
-- "relation zvd_translation_glossary does not exist". Surfaced during
-- the (db as any) cleanup pass when the route had to keep its cast
-- specifically because the table wasn't in DbSchema.

CREATE TABLE IF NOT EXISTS zvd_translation_glossary (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term        TEXT NOT NULL,
  locale      TEXT NOT NULL,
  translation TEXT NOT NULL,
  definition  TEXT,
  forbidden   BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, locale)
);

CREATE INDEX IF NOT EXISTS idx_translation_glossary_term ON zvd_translation_glossary (term);
CREATE INDEX IF NOT EXISTS idx_translation_glossary_locale ON zvd_translation_glossary (locale);

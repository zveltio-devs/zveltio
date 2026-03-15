-- Migration 009: Internationalization (i18n) translations

-- Translation keys registry
CREATE TABLE IF NOT EXISTS zvd_translation_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  context TEXT,                -- e.g. 'ui', 'content', 'email'
  default_value TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_translation_keys_key ON zvd_translation_keys(key);
CREATE INDEX IF NOT EXISTS idx_zvd_translation_keys_context ON zvd_translation_keys(context);

-- Translations (key + locale → value)
CREATE TABLE IF NOT EXISTS zvd_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID NOT NULL REFERENCES zvd_translation_keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  value TEXT NOT NULL,
  is_machine_translated BOOLEAN NOT NULL DEFAULT false,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(key_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_zvd_translations_key_locale ON zvd_translations(key_id, locale);
CREATE INDEX IF NOT EXISTS idx_zvd_translations_locale ON zvd_translations(locale);

-- Supported locales
CREATE TABLE IF NOT EXISTS zvd_locales (
  code TEXT PRIMARY KEY,         -- e.g. 'en', 'ro', 'de'
  name TEXT NOT NULL,            -- e.g. 'English', 'Română'
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default locales
INSERT INTO zvd_locales (code, name, is_default, is_active) VALUES
  ('en', 'English', true, true),
  ('ro', 'Română', false, true)
ON CONFLICT (code) DO NOTHING;

-- DOWN
DROP TABLE IF EXISTS zvd_locales;
DROP INDEX IF EXISTS idx_zvd_translations_locale;
DROP INDEX IF EXISTS idx_zvd_translations_key_locale;
DROP TABLE IF EXISTS zvd_translations;
DROP INDEX IF EXISTS idx_zvd_translation_keys_context;
DROP INDEX IF EXISTS idx_zvd_translation_keys_key;
DROP TABLE IF EXISTS zvd_translation_keys;

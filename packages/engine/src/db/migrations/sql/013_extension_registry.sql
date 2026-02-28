CREATE TABLE IF NOT EXISTS zv_extension_registry (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text         UNIQUE NOT NULL,
  display_name text         NOT NULL,
  description  text,
  category     text         NOT NULL DEFAULT 'custom',
  version      text         NOT NULL DEFAULT '1.0.0',
  author       text,
  is_installed boolean      NOT NULL DEFAULT false,
  is_enabled   boolean      NOT NULL DEFAULT false,
  config       jsonb        NOT NULL DEFAULT '{}',
  installed_at timestamptz,
  enabled_at   timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

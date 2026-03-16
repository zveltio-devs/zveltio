-- Migration 003: Settings system

CREATE TABLE IF NOT EXISTS zv_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default settings
INSERT INTO zv_settings (key, value, description, is_public)
VALUES
  (
    'branding',
    '{"logo_url": null, "company_name": "Zveltio", "primary_color": "#5BBFBA", "secondary_color": "#3a9e99", "dark_mode": false}',
    'Branding and theme settings',
    true
  ),
  (
    'smtp',
    '{"host": "", "port": 587, "secure": false, "user": "", "from_name": "Zveltio", "from_email": "noreply@zveltio.com"}',
    'SMTP configuration for email sending',
    false
  ),
  (
    'two_factor',
    '{"enabled": false, "required_for_admins": false, "required_for_all": false}',
    'Two-factor authentication settings',
    false
  ),
  (
    'api_docs_public',
    'false',
    'Whether API docs are publicly accessible',
    false
  ),
  (
    'site_url',
    '"http://localhost:3000"',
    'Public site URL for links and previews',
    true
  )
ON CONFLICT (key) DO NOTHING;

-- DOWN
DROP TABLE IF EXISTS zv_settings;

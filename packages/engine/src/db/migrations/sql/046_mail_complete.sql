-- 046_mail_complete.sql
-- Complete mail client: identities, signatures, drafts, sieve filters, address book, PGP keys, admin config

-- ═══ IDENTITIES / ALIASES ═══
CREATE TABLE IF NOT EXISTS zv_mail_identities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  email_address TEXT        NOT NULL,
  display_name  TEXT,
  reply_to      TEXT,
  bcc_self      BOOLEAN     NOT NULL DEFAULT false,
  is_default    BOOLEAN     NOT NULL DEFAULT false,
  sort_order    INT         NOT NULL DEFAULT 0,
  signature_id  UUID        DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_identities_account ON zv_mail_identities(account_id);

-- ═══ SIGNATURES ═══
CREATE TABLE IF NOT EXISTS zv_mail_signatures (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  body_html     TEXT        NOT NULL DEFAULT '',
  body_text     TEXT        NOT NULL DEFAULT '',
  is_default    BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_signatures_user ON zv_mail_signatures(user_id);

-- FK delayed (after both tables exist)
ALTER TABLE zv_mail_identities
  ADD CONSTRAINT IF NOT EXISTS fk_identity_signature
  FOREIGN KEY (signature_id) REFERENCES zv_mail_signatures(id) ON DELETE SET NULL;

-- ═══ DRAFTS ═══
CREATE TABLE IF NOT EXISTS zv_mail_drafts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  identity_id     UUID        REFERENCES zv_mail_identities(id) ON DELETE SET NULL,
  to_addresses    JSONB       NOT NULL DEFAULT '[]',
  cc_addresses    JSONB       NOT NULL DEFAULT '[]',
  bcc_addresses   JSONB       NOT NULL DEFAULT '[]',
  subject         TEXT        NOT NULL DEFAULT '',
  body_html       TEXT        NOT NULL DEFAULT '',
  body_text       TEXT        NOT NULL DEFAULT '',
  in_reply_to     TEXT,
  references_hdr  TEXT,
  reply_type      TEXT CHECK (reply_type IN ('reply', 'reply_all', 'forward', NULL)),
  original_msg_id UUID        REFERENCES zv_mail_messages(id) ON DELETE SET NULL,
  attachments     JSONB       NOT NULL DEFAULT '[]',
  priority        TEXT        DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  request_read_receipt BOOLEAN NOT NULL DEFAULT false,
  imap_uid        INT,
  auto_saved_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_drafts_account ON zv_mail_drafts(account_id);

-- ═══ SIEVE FILTERS ═══
CREATE TABLE IF NOT EXISTS zv_mail_filters (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  sort_order    INT         NOT NULL DEFAULT 0,
  conditions    JSONB       NOT NULL DEFAULT '[]',
  actions       JSONB       NOT NULL DEFAULT '[]',
  sieve_script  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_filters_account ON zv_mail_filters(account_id);

-- ═══ ADDRESS BOOK ═══
CREATE TABLE IF NOT EXISTS zv_mail_contacts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  display_name  TEXT,
  company       TEXT,
  phone         TEXT,
  frequency     INT         NOT NULL DEFAULT 1,
  last_used_at  TIMESTAMPTZ,
  source        TEXT        DEFAULT 'auto' CHECK (source IN ('auto', 'manual', 'import')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_mail_contacts_user ON zv_mail_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_mail_contacts_email ON zv_mail_contacts(email);
CREATE INDEX IF NOT EXISTS idx_mail_contacts_freq ON zv_mail_contacts(user_id, frequency DESC);

-- ═══ PGP KEYS ═══
CREATE TABLE IF NOT EXISTS zv_mail_pgp_keys (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  public_key    TEXT        NOT NULL,
  private_key   TEXT,
  fingerprint   TEXT        NOT NULL,
  is_own        BOOLEAN     NOT NULL DEFAULT false,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_pgp_email ON zv_mail_pgp_keys(email);
CREATE INDEX IF NOT EXISTS idx_mail_pgp_user ON zv_mail_pgp_keys(user_id);

-- ═══ EXTRA COLUMNS on zv_mail_accounts ═══
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS oauth2_provider TEXT DEFAULT NULL CHECK (oauth2_provider IN ('gmail', 'outlook', NULL));
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS oauth2_access_token TEXT DEFAULT NULL;
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS oauth2_refresh_token TEXT DEFAULT NULL;
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS oauth2_expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS imap_idle_supported BOOLEAN DEFAULT NULL;
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS sieve_host TEXT DEFAULT NULL;
ALTER TABLE zv_mail_accounts ADD COLUMN IF NOT EXISTS sieve_port INT DEFAULT 4190;

-- ═══ EXTRA COLUMNS on zv_mail_messages ═══
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low'));
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS read_receipt_requested BOOLEAN DEFAULT false;
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS read_receipt_sent BOOLEAN DEFAULT false;
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN DEFAULT false;
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS is_signed BOOLEAN DEFAULT false;
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS references_header TEXT DEFAULT NULL;
ALTER TABLE zv_mail_messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT DEFAULT NULL;

-- ═══ ADMIN MAIL CONFIG ═══
INSERT INTO zv_settings (key, value, description, is_public)
VALUES (
  'mail',
  '{
    "enabled": true,
    "max_accounts_per_user": 5,
    "max_attachment_size_mb": 25,
    "allowed_domains": [],
    "blocked_domains": [],
    "require_admin_approval": false,
    "auto_collect_contacts": true,
    "imap_idle_enabled": true,
    "sieve_enabled": true,
    "pgp_enabled": true,
    "oauth2_gmail_client_id": "",
    "oauth2_gmail_client_secret": "",
    "oauth2_outlook_client_id": "",
    "oauth2_outlook_client_secret": "",
    "max_messages_sync": 1000,
    "sync_interval_minutes": 5,
    "trash_auto_delete_days": 30
  }',
  'Mail client configuration (admin)',
  false
)
ON CONFLICT (key) DO NOTHING;

-- DOWN
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS in_reply_to;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS references_header;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS is_signed;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS is_encrypted;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS read_receipt_sent;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS read_receipt_requested;
ALTER TABLE zv_mail_messages DROP COLUMN IF EXISTS priority;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS sieve_port;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS sieve_host;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS imap_idle_supported;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS oauth2_expires_at;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS oauth2_refresh_token;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS oauth2_access_token;
ALTER TABLE zv_mail_accounts DROP COLUMN IF EXISTS oauth2_provider;
DROP INDEX IF EXISTS idx_mail_pgp_user;
DROP INDEX IF EXISTS idx_mail_pgp_email;
DROP TABLE IF EXISTS zv_mail_pgp_keys;
DROP INDEX IF EXISTS idx_mail_contacts_freq;
DROP INDEX IF EXISTS idx_mail_contacts_email;
DROP INDEX IF EXISTS idx_mail_contacts_user;
DROP TABLE IF EXISTS zv_mail_contacts;
DROP INDEX IF EXISTS idx_mail_filters_account;
DROP TABLE IF EXISTS zv_mail_filters;
DROP INDEX IF EXISTS idx_mail_drafts_account;
DROP TABLE IF EXISTS zv_mail_drafts;
DROP INDEX IF EXISTS idx_mail_signatures_user;
DROP TABLE IF EXISTS zv_mail_signatures;
DROP INDEX IF EXISTS idx_mail_identities_account;
DROP TABLE IF EXISTS zv_mail_identities;

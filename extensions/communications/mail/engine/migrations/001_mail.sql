-- Mail Client Extension
-- Stores IMAP account configurations and synced mail data

CREATE TABLE IF NOT EXISTS zv_mail_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  -- IMAP
  imap_host   TEXT NOT NULL,
  imap_port   INTEGER NOT NULL DEFAULT 993,
  imap_secure BOOLEAN NOT NULL DEFAULT true,
  imap_user   TEXT NOT NULL,
  imap_pass   TEXT NOT NULL, -- encrypted at application layer
  -- SMTP
  smtp_host   TEXT NOT NULL,
  smtp_port   INTEGER NOT NULL DEFAULT 587,
  smtp_secure BOOLEAN NOT NULL DEFAULT true,
  smtp_user   TEXT,
  smtp_pass   TEXT,
  -- Sync state
  last_synced_at TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zv_mail_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  delimiter   TEXT NOT NULL DEFAULT '/',
  flags       TEXT[] DEFAULT '{}',
  message_count INTEGER DEFAULT 0,
  unseen_count  INTEGER DEFAULT 0,
  uidvalidity   BIGINT,
  uidnext       BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, path)
);

CREATE TABLE IF NOT EXISTS zv_mail_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  folder_id   UUID NOT NULL REFERENCES zv_mail_folders(id) ON DELETE CASCADE,
  uid         BIGINT NOT NULL,
  message_id  TEXT,
  thread_id   TEXT,
  subject     TEXT,
  "from"      JSONB,        -- { name, address }
  "to"        JSONB,        -- [{ name, address }]
  cc          JSONB,
  bcc         JSONB,
  date        TIMESTAMPTZ,
  flags       TEXT[] DEFAULT '{}',
  has_attachments BOOLEAN DEFAULT false,
  size        INTEGER,
  snippet     TEXT,         -- first 200 chars of plain text
  body_text   TEXT,
  body_html   TEXT,
  attachments JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, folder_id, uid)
);

CREATE TABLE IF NOT EXISTS zv_mail_sieve_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  conditions  JSONB NOT NULL DEFAULT '[]',
  actions     JSONB NOT NULL DEFAULT '[]',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_account ON zv_mail_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_folder ON zv_mail_messages(folder_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_date ON zv_mail_messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON zv_mail_messages(thread_id) WHERE thread_id IS NOT NULL;

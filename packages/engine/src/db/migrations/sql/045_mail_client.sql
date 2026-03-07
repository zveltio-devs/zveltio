-- 045_mail_client.sql
-- Zveltio Mail Client: accounts, folders, messages, attachments

-- ═══ MAIL ACCOUNTS ═══
CREATE TABLE IF NOT EXISTS zv_mail_accounts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  email_address TEXT        NOT NULL,
  display_name  TEXT,

  imap_host     TEXT        NOT NULL,
  imap_port     INT         NOT NULL DEFAULT 993,
  imap_secure   BOOLEAN     NOT NULL DEFAULT true,
  imap_user     TEXT        NOT NULL,
  imap_password TEXT        NOT NULL,

  smtp_host     TEXT        NOT NULL,
  smtp_port     INT         NOT NULL DEFAULT 587,
  smtp_secure   BOOLEAN     NOT NULL DEFAULT true,
  smtp_user     TEXT,
  smtp_password TEXT,

  is_default    BOOLEAN     NOT NULL DEFAULT false,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  last_sync_at  TIMESTAMPTZ,
  sync_error    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON zv_mail_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_default
  ON zv_mail_accounts(user_id) WHERE is_default = true;

-- ═══ MAIL FOLDERS ═══
CREATE TABLE IF NOT EXISTS zv_mail_folders (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  path          TEXT        NOT NULL,
  type          TEXT        DEFAULT 'other'
                CHECK (type IN ('inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'other')),
  unread_count  INT         NOT NULL DEFAULT 0,
  total_count   INT         NOT NULL DEFAULT 0,
  last_uid      INT         DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, path)
);

CREATE INDEX IF NOT EXISTS idx_mail_folders_account ON zv_mail_folders(account_id);

-- ═══ MAIL MESSAGES ═══
CREATE TABLE IF NOT EXISTS zv_mail_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES zv_mail_accounts(id) ON DELETE CASCADE,
  folder_id       UUID        NOT NULL REFERENCES zv_mail_folders(id) ON DELETE CASCADE,
  message_id      TEXT,
  uid             INT,
  thread_id       TEXT,

  from_address    TEXT        NOT NULL,
  from_name       TEXT,
  to_addresses    JSONB       NOT NULL DEFAULT '[]',
  cc_addresses    JSONB       NOT NULL DEFAULT '[]',
  bcc_addresses   JSONB       NOT NULL DEFAULT '[]',
  reply_to        TEXT,

  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  snippet         TEXT,

  is_read         BOOLEAN     NOT NULL DEFAULT false,
  is_starred      BOOLEAN     NOT NULL DEFAULT false,
  is_draft        BOOLEAN     NOT NULL DEFAULT false,
  has_attachments BOOLEAN     NOT NULL DEFAULT false,

  sent_at         TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  tags            TEXT[]      DEFAULT '{}',
  raw_headers     JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_account ON zv_mail_messages(account_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_date ON zv_mail_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON zv_mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_from ON zv_mail_messages(from_address);
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread ON zv_mail_messages(account_id, is_read) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS idx_mail_messages_search ON zv_mail_messages
  USING GIN(to_tsvector('simple', COALESCE(subject, '') || ' ' || COALESCE(body_text, '')));

-- ═══ MAIL ATTACHMENTS ═══
CREATE TABLE IF NOT EXISTS zv_mail_attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID        NOT NULL REFERENCES zv_mail_messages(id) ON DELETE CASCADE,
  filename      TEXT        NOT NULL,
  mime_type     TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL,
  storage_path  TEXT,
  content_id    TEXT,
  is_inline     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_attachments_msg ON zv_mail_attachments(message_id);

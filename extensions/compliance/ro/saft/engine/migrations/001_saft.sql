-- SAF-T RO: Standard Audit File for Tax
CREATE TABLE IF NOT EXISTS zv_saft_exports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  company_name    TEXT NOT NULL,
  company_cui     TEXT NOT NULL,
  company_address TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | generated | submitted
  xml_content     TEXT,
  anaf_response   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saft_exports_status ON zv_saft_exports(status);
CREATE INDEX IF NOT EXISTS idx_saft_exports_period ON zv_saft_exports(period_start DESC);

-- Chart of accounts
CREATE TABLE IF NOT EXISTS zv_saft_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL,
  account_type    TEXT NOT NULL DEFAULT 'balance',  -- balance | income | expense
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saft_accounts_code ON zv_saft_accounts(code);

-- General ledger journal entries
CREATE TABLE IF NOT EXISTS zv_saft_journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code    TEXT NOT NULL,
  entry_date      DATE NOT NULL,
  description     TEXT NOT NULL,
  debit           NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(14,2) NOT NULL DEFAULT 0,
  document_number TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saft_entries_date ON zv_saft_journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_saft_entries_account ON zv_saft_journal_entries(account_code);

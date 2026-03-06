-- 042_core_schemas.sql
-- Zveltio Core Schemas: universal entities that extensions can reference via foreign keys.
-- Prefix zvd_ = user data (not system). schema_locked = false: admins can ADD columns but not remove core ones.

-- ═══ CONTACTS (individuals) ═══
CREATE TABLE IF NOT EXISTS zvd_contacts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      TEXT        NOT NULL,
  last_name       TEXT        NOT NULL,
  email           TEXT,
  phone           TEXT,
  company         TEXT,
  job_title       TEXT,
  avatar_url      TEXT,
  address         JSONB       DEFAULT '{}',
  tags            TEXT[]      DEFAULT '{}',
  notes           TEXT,
  source          TEXT,
  external_id     TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_email ON zvd_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON zvd_contacts(company);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON zvd_contacts(last_name, first_name);

-- ═══ ORGANIZATIONS (companies/institutions) ═══
CREATE TABLE IF NOT EXISTS zvd_organizations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  legal_name      TEXT,
  tax_id          TEXT,
  registration_no TEXT,
  type            TEXT        DEFAULT 'company' CHECK (type IN ('company', 'nonprofit', 'government', 'individual')),
  industry        TEXT,
  website         TEXT,
  email           TEXT,
  phone           TEXT,
  address         JSONB       DEFAULT '{}',
  billing_address JSONB       DEFAULT '{}',
  logo_url        TEXT,
  tags            TEXT[]      DEFAULT '{}',
  metadata        JSONB       NOT NULL DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orgs_name ON zvd_organizations(name);
CREATE INDEX IF NOT EXISTS idx_orgs_tax ON zvd_organizations(tax_id);

-- ═══ CONTACTS ↔ ORGANIZATIONS link ═══
CREATE TABLE IF NOT EXISTS zvd_contact_organizations (
  contact_id      UUID        NOT NULL REFERENCES zvd_contacts(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL REFERENCES zvd_organizations(id) ON DELETE CASCADE,
  role            TEXT,
  is_primary      BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (contact_id, organization_id)
);

-- ═══ TRANSACTIONS (generic financial transactions) ═══
CREATE TABLE IF NOT EXISTS zvd_transactions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT          NOT NULL CHECK (type IN ('invoice', 'payment', 'credit_note', 'expense', 'transfer', 'other')),
  status          TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'completed', 'cancelled', 'refunded')),
  number          TEXT,
  organization_id UUID          REFERENCES zvd_organizations(id) ON DELETE SET NULL,
  contact_id      UUID          REFERENCES zvd_contacts(id) ON DELETE SET NULL,
  currency        TEXT          NOT NULL DEFAULT 'RON',
  amount          DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount    DECIMAL(15,2) NOT NULL DEFAULT 0,
  due_date        DATE,
  paid_date       DATE,
  line_items      JSONB         NOT NULL DEFAULT '[]',
  notes           TEXT,
  reference       TEXT,
  metadata        JSONB         NOT NULL DEFAULT '{}',
  created_by      TEXT          REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_org ON zvd_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON zvd_transactions(type, status);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON zvd_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_number ON zvd_transactions(number);

-- ═══ Register in zvd_collections so they appear in Studio ═══
INSERT INTO zvd_collections (name, display_name, icon, is_system, schema_locked)
VALUES
  ('contacts',      'Contacts',      'Users',    true, false),
  ('organizations', 'Organizations', 'Building2', true, false),
  ('transactions',  'Transactions',  'Receipt',  true, false)
ON CONFLICT (name) DO NOTHING;

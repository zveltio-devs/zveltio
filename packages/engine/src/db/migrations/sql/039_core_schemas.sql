-- 039_core_schemas.sql
-- Zveltio Core Schemas: universal entities that extensions can reference via foreign keys.
-- Prefix zvd_ = user data (not system). schema_locked = false: admins can ADD columns but not remove core ones.
--
-- All tables follow the DDLManager contract:
--   - system columns (id, created_at, updated_at, status, created_by, updated_by)
--   - search_vector + GIN index + FTS trigger (populated from text columns)
--   - per-table updated_at trigger (NO global function — avoids race on concurrent creates)
--   - registered in zvd_collections with fields[] matching the physical schema
--   - is_managed = true so DDL queue routes through DDLManager (respects BYOD guard)

-- ═══ Extend zvd_collections with system/lock flags (required before INSERT below) ═══
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_system     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS schema_locked BOOLEAN NOT NULL DEFAULT false;

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
  search_vector   TSVECTOR,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  created_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  updated_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_email  ON zvd_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON zvd_contacts(company);
CREATE INDEX IF NOT EXISTS idx_contacts_name   ON zvd_contacts(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_zvd_contacts_search ON zvd_contacts USING GIN(search_vector);

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
  search_vector   TSVECTOR,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  created_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  updated_by      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orgs_name ON zvd_organizations(name);
CREATE INDEX IF NOT EXISTS idx_orgs_tax  ON zvd_organizations(tax_id);
CREATE INDEX IF NOT EXISTS idx_zvd_organizations_search ON zvd_organizations USING GIN(search_vector);

-- ═══ CONTACTS ↔ ORGANIZATIONS link (m2m junction) ═══
CREATE TABLE IF NOT EXISTS zvd_contact_organizations (
  contact_id      UUID        NOT NULL REFERENCES zvd_contacts(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL REFERENCES zvd_organizations(id) ON DELETE CASCADE,
  role            TEXT,
  is_primary      BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (contact_id, organization_id)
);

-- ═══ TRANSACTIONS (generic financial transactions) ═══
-- status uses a domain-specific CHECK (invoice lifecycle), intentionally diverging
-- from the generic 'active/draft/archived' default. DDLManager-created collections
-- get the generic CHECK; this one is an application-level override.
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
  search_vector   TSVECTOR,
  created_by      TEXT          REFERENCES "user"(id) ON DELETE SET NULL,
  updated_by      TEXT          REFERENCES "user"(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_org    ON zvd_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type   ON zvd_transactions(type, status);
CREATE INDEX IF NOT EXISTS idx_transactions_date   ON zvd_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_number ON zvd_transactions(number);
CREATE INDEX IF NOT EXISTS idx_zvd_transactions_search ON zvd_transactions USING GIN(search_vector);

-- ═══ Per-table FTS trigger functions ═══
-- Scoped per table (not a global update_updated_at_column) so two concurrent
-- createCollection() calls can't clobber each other's logic.
CREATE OR REPLACE FUNCTION zvd_contacts_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.first_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.last_name,  '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.email,      '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.company,    '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.notes,      '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION zvd_organizations_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name,       '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.legal_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.email,      '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.industry,   '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION zvd_transactions_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.number,    '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.reference, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.notes,     '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zvd_contacts_search_update      ON zvd_contacts;
DROP TRIGGER IF EXISTS zvd_organizations_search_update ON zvd_organizations;
DROP TRIGGER IF EXISTS zvd_transactions_search_update  ON zvd_transactions;

CREATE TRIGGER zvd_contacts_search_update      BEFORE INSERT OR UPDATE ON zvd_contacts      FOR EACH ROW EXECUTE FUNCTION zvd_contacts_search_trigger();
CREATE TRIGGER zvd_organizations_search_update BEFORE INSERT OR UPDATE ON zvd_organizations FOR EACH ROW EXECUTE FUNCTION zvd_organizations_search_trigger();
CREATE TRIGGER zvd_transactions_search_update  BEFORE INSERT OR UPDATE ON zvd_transactions  FOR EACH ROW EXECUTE FUNCTION zvd_transactions_search_trigger();

-- ═══ Per-table updated_at trigger functions ═══
CREATE OR REPLACE FUNCTION zvd_contacts_touch_updated_at()      RETURNS trigger AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION zvd_organizations_touch_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION zvd_transactions_touch_updated_at()  RETURNS trigger AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_zvd_contacts_updated_at      ON zvd_contacts;
DROP TRIGGER IF EXISTS update_zvd_organizations_updated_at ON zvd_organizations;
DROP TRIGGER IF EXISTS update_zvd_transactions_updated_at  ON zvd_transactions;

CREATE TRIGGER update_zvd_contacts_updated_at      BEFORE UPDATE ON zvd_contacts      FOR EACH ROW EXECUTE FUNCTION zvd_contacts_touch_updated_at();
CREATE TRIGGER update_zvd_organizations_updated_at BEFORE UPDATE ON zvd_organizations FOR EACH ROW EXECUTE FUNCTION zvd_organizations_touch_updated_at();
CREATE TRIGGER update_zvd_transactions_updated_at  BEFORE UPDATE ON zvd_transactions  FOR EACH ROW EXECUTE FUNCTION zvd_transactions_touch_updated_at();

-- ═══ Register in zvd_collections (fields[] mirrors physical schema) ═══
-- Without fields populated, Studio spams the API trying to discover schema,
-- processInput/serializeRecord can't validate/encrypt, and the UI shows 0 fields.
INSERT INTO zvd_collections (name, display_name, icon, is_system, schema_locked, is_managed, fields)
VALUES
  ('contacts', 'Contacts', 'Users', true, false, true, '[
    {"name":"first_name", "type":"text",     "required":true,  "label":"First name"},
    {"name":"last_name",  "type":"text",     "required":true,  "label":"Last name"},
    {"name":"email",      "type":"email",    "required":false, "indexed":true, "label":"Email"},
    {"name":"phone",      "type":"text",     "required":false, "label":"Phone"},
    {"name":"company",    "type":"text",     "required":false, "indexed":true, "label":"Company"},
    {"name":"job_title",  "type":"text",     "required":false, "label":"Job title"},
    {"name":"avatar_url", "type":"text",     "required":false, "label":"Avatar URL"},
    {"name":"address",    "type":"json",     "required":false, "label":"Address"},
    {"name":"tags",       "type":"tags",     "required":false, "label":"Tags"},
    {"name":"notes",      "type":"richtext", "required":false, "label":"Notes"},
    {"name":"source",     "type":"text",     "required":false, "label":"Source"},
    {"name":"external_id","type":"text",     "required":false, "label":"External ID"},
    {"name":"metadata",   "type":"json",     "required":false, "label":"Metadata"}
  ]'::jsonb),
  ('organizations', 'Organizations', 'Building2', true, false, true, '[
    {"name":"name",            "type":"text",    "required":true,  "indexed":true, "label":"Name"},
    {"name":"legal_name",      "type":"text",    "required":false, "label":"Legal name"},
    {"name":"tax_id",          "type":"text",    "required":false, "indexed":true, "label":"Tax ID"},
    {"name":"registration_no", "type":"text",    "required":false, "label":"Registration number"},
    {"name":"type",            "type":"text",    "required":false, "label":"Type"},
    {"name":"industry",        "type":"text",    "required":false, "label":"Industry"},
    {"name":"website",         "type":"text",    "required":false, "label":"Website"},
    {"name":"email",           "type":"email",   "required":false, "label":"Email"},
    {"name":"phone",           "type":"text",    "required":false, "label":"Phone"},
    {"name":"address",         "type":"json",    "required":false, "label":"Address"},
    {"name":"billing_address", "type":"json",    "required":false, "label":"Billing address"},
    {"name":"logo_url",        "type":"text",    "required":false, "label":"Logo URL"},
    {"name":"tags",            "type":"tags",    "required":false, "label":"Tags"},
    {"name":"metadata",        "type":"json",    "required":false, "label":"Metadata"},
    {"name":"is_active",       "type":"boolean", "required":true,  "label":"Active"}
  ]'::jsonb),
  ('transactions', 'Transactions', 'Receipt', true, false, true, '[
    {"name":"type",            "type":"text",    "required":true,  "label":"Type"},
    {"name":"number",          "type":"text",    "required":false, "indexed":true, "label":"Number"},
    {"name":"organization_id", "type":"uuid",    "required":false, "indexed":true, "label":"Organization"},
    {"name":"contact_id",      "type":"uuid",    "required":false, "label":"Contact"},
    {"name":"currency",        "type":"text",    "required":true,  "label":"Currency"},
    {"name":"amount",          "type":"number",  "required":true,  "label":"Amount"},
    {"name":"tax_amount",      "type":"number",  "required":true,  "label":"Tax amount"},
    {"name":"total_amount",    "type":"number",  "required":true,  "label":"Total amount"},
    {"name":"due_date",        "type":"date",    "required":false, "label":"Due date"},
    {"name":"paid_date",       "type":"date",    "required":false, "label":"Paid date"},
    {"name":"line_items",      "type":"json",    "required":true,  "label":"Line items"},
    {"name":"notes",           "type":"richtext","required":false, "label":"Notes"},
    {"name":"reference",       "type":"text",    "required":false, "label":"Reference"},
    {"name":"metadata",        "type":"json",    "required":false, "label":"Metadata"}
  ]'::jsonb)
-- If the row already exists (earlier alpha populated fields='[]'), overwrite
-- fields with the correct schema. Only fields/is_managed/display_name/icon
-- are touched — user-customized flags like is_system/schema_locked stay.
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  icon         = EXCLUDED.icon,
  is_managed   = EXCLUDED.is_managed,
  fields       = EXCLUDED.fields,
  updated_at   = NOW()
WHERE zvd_collections.fields = '[]'::jsonb OR zvd_collections.fields IS NULL;

-- ═══ Register the m2m junction so Studio can navigate the relation ═══
INSERT INTO zvd_relations (name, type, source_collection, source_field, target_collection, target_field, junction_table, on_delete, on_update)
VALUES ('contact_organizations', 'm2m', 'contacts', 'id', 'organizations', 'id', 'zvd_contact_organizations', 'CASCADE', 'CASCADE')
ON CONFLICT (source_collection, source_field) DO NOTHING;

-- DOWN
DELETE FROM zvd_relations WHERE source_collection = 'contacts' AND source_field = 'id' AND target_collection = 'organizations';
DROP TRIGGER IF EXISTS update_zvd_transactions_updated_at  ON zvd_transactions;
DROP TRIGGER IF EXISTS update_zvd_organizations_updated_at ON zvd_organizations;
DROP TRIGGER IF EXISTS update_zvd_contacts_updated_at      ON zvd_contacts;
DROP FUNCTION IF EXISTS zvd_transactions_touch_updated_at();
DROP FUNCTION IF EXISTS zvd_organizations_touch_updated_at();
DROP FUNCTION IF EXISTS zvd_contacts_touch_updated_at();
DROP TRIGGER IF EXISTS zvd_transactions_search_update  ON zvd_transactions;
DROP TRIGGER IF EXISTS zvd_organizations_search_update ON zvd_organizations;
DROP TRIGGER IF EXISTS zvd_contacts_search_update      ON zvd_contacts;
DROP FUNCTION IF EXISTS zvd_transactions_search_trigger();
DROP FUNCTION IF EXISTS zvd_organizations_search_trigger();
DROP FUNCTION IF EXISTS zvd_contacts_search_trigger();
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS schema_locked;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_system;
DROP TABLE IF EXISTS zvd_contact_organizations;
DROP INDEX IF EXISTS idx_zvd_transactions_search;
DROP INDEX IF EXISTS idx_transactions_number;
DROP INDEX IF EXISTS idx_transactions_date;
DROP INDEX IF EXISTS idx_transactions_type;
DROP INDEX IF EXISTS idx_transactions_org;
DROP TABLE IF EXISTS zvd_transactions;
DROP INDEX IF EXISTS idx_zvd_organizations_search;
DROP INDEX IF EXISTS idx_orgs_tax;
DROP INDEX IF EXISTS idx_orgs_name;
DROP TABLE IF EXISTS zvd_organizations;
DROP INDEX IF EXISTS idx_zvd_contacts_search;
DROP INDEX IF EXISTS idx_contacts_name;
DROP INDEX IF EXISTS idx_contacts_company;
DROP INDEX IF EXISTS idx_contacts_email;
DROP TABLE IF EXISTS zvd_contacts;

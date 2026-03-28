-- ═══════════════════════════════════════════════════════════════
-- Client Portal: infrastructure for all 4 templates
-- Templates: generic, saas, services, regulatory
-- ═══════════════════════════════════════════════════════════════

-- Active portal configuration (one row per instance)
CREATE TABLE IF NOT EXISTS zv_portal_config (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template    TEXT        NOT NULL DEFAULT 'generic'
                          CHECK (template IN ('generic', 'saas', 'services', 'regulatory')),
  is_enabled  BOOLEAN     NOT NULL DEFAULT false,
  site_name   TEXT        NOT NULL DEFAULT 'Client Portal',
  site_logo   TEXT,
  primary_color TEXT      DEFAULT '#069494',
  config      JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default config
INSERT INTO zv_portal_config (template, is_enabled) VALUES ('generic', false)
ON CONFLICT DO NOTHING;

-- ── Regulatory template tables ────────────────────────────────

-- Economic operators (companies) that interact with the institution
CREATE TABLE IF NOT EXISTS zv_portal_operators (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_code     TEXT        NOT NULL UNIQUE,   -- CUI / CIF
  name            TEXT        NOT NULL,
  legal_form      TEXT,                          -- SRL, SA, PFA, etc.
  address         TEXT,
  county          TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'suspended', 'inactive')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_operators_fiscal ON zv_portal_operators(fiscal_code);

-- Users linked as representatives of operators
CREATE TABLE IF NOT EXISTS zv_portal_operator_users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID        NOT NULL REFERENCES zv_portal_operators(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'representative'
                          CHECK (role IN ('owner', 'representative', 'viewer')),
  is_verified BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(operator_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_op_users_user ON zv_portal_operator_users(user_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_op_users_op   ON zv_portal_operator_users(operator_id);

-- Business locations (puncte de lucru)
CREATE TABLE IF NOT EXISTS zv_portal_locations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID        NOT NULL REFERENCES zv_portal_operators(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  address         TEXT        NOT NULL,
  county          TEXT,
  activity_code   TEXT,                          -- CAEN code
  activity_desc   TEXT,
  location_type   TEXT        DEFAULT 'sediu_secundar',
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_locations_op ON zv_portal_locations(operator_id);

-- Authorization requests (cereri de autorizare)
CREATE TABLE IF NOT EXISTS zv_portal_authorizations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         UUID        NOT NULL REFERENCES zv_portal_operators(id) ON DELETE CASCADE,
  location_id         UUID        REFERENCES zv_portal_locations(id) ON DELETE SET NULL,
  authorization_type  TEXT        NOT NULL,
  reference_number    TEXT        UNIQUE,
  title               TEXT        NOT NULL,
  description         TEXT,
  status              TEXT        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','submitted','under_review','approved','rejected','needs_info','expired')),
  submitted_at        TIMESTAMPTZ,
  reviewed_at         TIMESTAMPTZ,
  reviewer_id         TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  reviewer_notes      TEXT,
  valid_from          DATE,
  valid_until         DATE,
  created_by          TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_auth_op     ON zv_portal_authorizations(operator_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_auth_status ON zv_portal_authorizations(status);

-- Inspections (controale) — created by institution, visible to operators
CREATE TABLE IF NOT EXISTS zv_portal_inspections (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID        NOT NULL REFERENCES zv_portal_operators(id) ON DELETE CASCADE,
  location_id     UUID        REFERENCES zv_portal_locations(id) ON DELETE SET NULL,
  reference_number TEXT       UNIQUE,
  inspection_type TEXT        NOT NULL DEFAULT 'routine',
  scheduled_date  TIMESTAMPTZ,
  completed_date  TIMESTAMPTZ,
  inspector_name  TEXT,
  inspector_team  TEXT,
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  result          TEXT        CHECK (result IN ('passed','failed','needs_remediation','pending',NULL)),
  findings        TEXT,
  report_url      TEXT,
  remediation_deadline DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_insp_op     ON zv_portal_inspections(operator_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_insp_status ON zv_portal_inspections(status);

-- Generic requests / cereri diverse
CREATE TABLE IF NOT EXISTS zv_portal_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID        REFERENCES zv_portal_operators(id) ON DELETE SET NULL,
  user_id         TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  reference_number TEXT       UNIQUE,
  request_type    TEXT        NOT NULL DEFAULT 'general',
  subject         TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'submitted'
                              CHECK (status IN ('submitted','in_progress','awaiting_docs','completed','rejected')),
  priority        TEXT        NOT NULL DEFAULT 'normal'
                              CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to     TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  response        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_req_op   ON zv_portal_requests(operator_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_req_user ON zv_portal_requests(user_id);

-- Documents attached to requests, authorizations, or operator profile
CREATE TABLE IF NOT EXISTS zv_portal_documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         UUID        REFERENCES zv_portal_operators(id) ON DELETE CASCADE,
  authorization_id    UUID        REFERENCES zv_portal_authorizations(id) ON DELETE CASCADE,
  inspection_id       UUID        REFERENCES zv_portal_inspections(id) ON DELETE CASCADE,
  request_id          UUID        REFERENCES zv_portal_requests(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  file_key            TEXT        NOT NULL,
  file_size           BIGINT,
  mime_type           TEXT,
  document_type       TEXT        NOT NULL DEFAULT 'attachment',
  direction           TEXT        NOT NULL DEFAULT 'upload'
                                  CHECK (direction IN ('upload','download')),
  uploaded_by         TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_docs_op   ON zv_portal_documents(operator_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_docs_auth ON zv_portal_documents(authorization_id);

-- ── Generic / SaaS / Services tables ─────────────────────────

-- Support tickets (generic + saas + services)
CREATE TABLE IF NOT EXISTS zv_portal_tickets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  operator_id     UUID        REFERENCES zv_portal_operators(id) ON DELETE SET NULL,
  subject         TEXT        NOT NULL,
  description     TEXT,
  category        TEXT        DEFAULT 'general',
  status          TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','in_progress','resolved','closed')),
  priority        TEXT        NOT NULL DEFAULT 'normal',
  assigned_to     TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ticket messages (thread)
CREATE TABLE IF NOT EXISTS zv_portal_ticket_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID        NOT NULL REFERENCES zv_portal_tickets(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  is_internal BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_portal_tickets_user ON zv_portal_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_zv_portal_tmsg_ticket  ON zv_portal_ticket_messages(ticket_id);

-- Add client role to zv_roles if not present
INSERT INTO zv_roles (name, description)
VALUES ('client', 'Client portal user — access to the client portal zone')
ON CONFLICT (name) DO NOTHING;

-- Casbin: client role can access portal resources
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'client', 'portal', 'read'),
  ('p', 'client', 'portal', 'write')
ON CONFLICT DO NOTHING;

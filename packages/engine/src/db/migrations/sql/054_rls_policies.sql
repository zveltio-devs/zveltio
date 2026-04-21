-- Row-Level Security policies (application-layer, Directus-style)
-- Each policy injects a WHERE clause into queries for a given collection + role.
-- Evaluated after Casbin (collection-level check passes first).

CREATE TABLE IF NOT EXISTS zvd_rls_policies (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection          TEXT        NOT NULL,   -- collection slug or '*' (all collections)
  role                TEXT        NOT NULL,   -- Casbin role name or '*' (all roles)
  filter_field        TEXT        NOT NULL,   -- field to filter on (e.g. 'created_by')
  filter_op           TEXT        NOT NULL DEFAULT 'eq', -- eq | neq | in | not_in
  filter_value_source TEXT        NOT NULL,
    -- 'user_id'     → current authenticated user's id
    -- 'user_email'  → current authenticated user's email
    -- 'user_role'   → current authenticated user's role
    -- 'static:VAL'  → literal value VAL (e.g. 'static:published')
  is_enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rls_policies_lookup
  ON zvd_rls_policies (collection, role, is_enabled);

COMMENT ON TABLE zvd_rls_policies IS
  'Application-layer row-level security: policies injected as WHERE clauses at query time.';

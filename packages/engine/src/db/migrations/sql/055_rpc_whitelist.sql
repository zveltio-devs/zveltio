-- RPC function whitelist — only explicitly registered PostgreSQL functions
-- can be called via POST /api/rpc/:function.

CREATE TABLE IF NOT EXISTS zvd_rpc_functions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name TEXT        NOT NULL UNIQUE,  -- exact PostgreSQL function name
  description   TEXT,
  required_role TEXT        NOT NULL DEFAULT 'member', -- minimum role to call
  is_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpc_functions_lookup
  ON zvd_rpc_functions (function_name, is_enabled);

COMMENT ON TABLE zvd_rpc_functions IS
  'Whitelist of PostgreSQL functions exposed via POST /api/rpc/:function. '
  'Only functions explicitly registered here can be called by API clients.';

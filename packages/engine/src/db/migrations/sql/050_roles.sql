-- Custom roles table for RBAC
-- Casbin uses role names (strings) as subjects in policies.
-- This table persists named roles so the Studio can manage them.

CREATE TABLE IF NOT EXISTS zv_roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_roles_name ON zv_roles(name);

-- Seed built-in roles (employee is the baseline non-admin role)
INSERT INTO zv_roles (name, description)
VALUES
  ('employee', 'Employee role — grants access to the intranet portal'),
  ('manager',  'Manager role — inherits employee, can approve requests and view reports')
ON CONFLICT (name) DO NOTHING;

-- Casbin: employee can read intranet resources
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'employee', 'intranet', 'read'),
  ('p', 'employee', 'intranet', 'write'),
  ('p', 'manager',  'intranet', 'read'),
  ('p', 'manager',  'intranet', 'write'),
  -- manager inherits all employee permissions via Casbin role hierarchy
  ('g', 'manager', 'employee', NULL)
ON CONFLICT DO NOTHING;

-- 077_extension_rbac_defaults.sql
--
-- Seeds Casbin policies so the per-extension `permissionGate` (SDK)
-- has sensible defaults when an operator turns it on.
--
-- Without these rows, every extension route gated by `permissionGate`
-- would 403 for non-god users — even basic read access. This migration
-- grants the built-in `employee` and `manager` roles minimal access
-- to the official extensions; operators tighten or relax via the
-- Studio Roles UI.
--
-- Convention: the gate's `resource` is the extension's logical name
-- (e.g. `'crm'`, `'invoices'`). Actions follow the standard CRUD
-- mapping (read / create / update / delete).
--
-- IMPORTANT — `g` row required: Casbin's matcher is
--   g(r.sub, p.sub) && (r.obj == p.obj || p.obj == '*') && (r.act == p.act || p.act == '*')
-- so a user must be mapped to the 'employee' or 'manager' role via a
-- `g` row before the `p` rows below take effect, e.g.
--   INSERT INTO zvd_permissions (ptype, v0, v1, v2)
--   VALUES ('g', '<user-id>', 'employee', NULL);
-- The Studio Roles UI exposes that mapping; no users are mapped by
-- default.

-- Casbin policy rows are conceptually unique on (ptype, v0, v1, v2)
-- (and v3..v5 for the rare extended-policy types). Without an explicit
-- unique index, ON CONFLICT below would have nothing to arbitrate on
-- and re-running this migration would duplicate every policy row,
-- bloating the in-memory enforcer and the policy cache. Add the index
-- as part of this migration so the ON CONFLICT clauses actually
-- deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_zvd_permissions_policy_unique
  ON zvd_permissions (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, ''));

-- Read-only baseline for `employee` on day-to-day operational extensions.
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'employee', 'crm',                  'read'),
  ('p', 'employee', 'invoices',             'read'),
  ('p', 'employee', 'quotes',               'read'),
  ('p', 'employee', 'expenses',             'read'),
  ('p', 'employee', 'expenses',             'create'),
  ('p', 'employee', 'inventory',            'read'),
  ('p', 'employee', 'helpdesk',             'read'),
  ('p', 'employee', 'helpdesk',             'create'),
  ('p', 'employee', 'projects',             'read'),
  ('p', 'employee', 'documents',            'read'),
  ('p', 'employee', 'document-templates',   'read'),
  ('p', 'employee', 'media',                'read'),
  ('p', 'employee', 'forms',                'read'),
  ('p', 'employee', 'search',               'read'),
  ('p', 'employee', 'translations',         'read'),
  ('p', 'employee', 'checklists',           'read'),
  -- leave/time-tracking are SHARED tables; the gate is method+resource
  -- (not row-level), so granting an employee 'update' here would let
  -- them modify ANY user's leave request. Stay on read+create only —
  -- the extension handlers must use `entityAccess.register()` if they
  -- want to let an employee edit their own submission.
  ('p', 'employee', 'leave',                'create'),
  ('p', 'employee', 'leave',                'read'),
  ('p', 'employee', 'time-tracking',        'read'),
  ('p', 'employee', 'time-tracking',        'create'),
  ('p', 'employee', 'assets',               'read'),
  ('p', 'employee', 'pos',                  'read')
ON CONFLICT (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, '')) DO NOTHING;

-- Manager: write access on most operational extensions; HR/finance stay
-- read-only here (operators add the specifics via Studio).
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'manager', 'crm',                  'read'),
  ('p', 'manager', 'crm',                  'create'),
  ('p', 'manager', 'crm',                  'update'),
  ('p', 'manager', 'invoices',             'read'),
  ('p', 'manager', 'invoices',             'create'),
  ('p', 'manager', 'invoices',             'update'),
  ('p', 'manager', 'quotes',               'read'),
  ('p', 'manager', 'quotes',               'create'),
  ('p', 'manager', 'quotes',               'update'),
  ('p', 'manager', 'expenses',             'read'),
  ('p', 'manager', 'expenses',             'create'),
  ('p', 'manager', 'expenses',             'update'),
  ('p', 'manager', 'inventory',            'read'),
  ('p', 'manager', 'inventory',            'create'),
  ('p', 'manager', 'inventory',            'update'),
  ('p', 'manager', 'helpdesk',             'read'),
  ('p', 'manager', 'helpdesk',             'create'),
  ('p', 'manager', 'helpdesk',             'update'),
  ('p', 'manager', 'projects',             'read'),
  ('p', 'manager', 'projects',             'create'),
  ('p', 'manager', 'projects',             'update'),
  ('p', 'manager', 'documents',            'read'),
  ('p', 'manager', 'documents',            'create'),
  ('p', 'manager', 'document-templates',   'read'),
  ('p', 'manager', 'media',                'read'),
  ('p', 'manager', 'media',                'create'),
  ('p', 'manager', 'media',                'update'),
  ('p', 'manager', 'forms',                'read'),
  ('p', 'manager', 'search',               'read'),
  ('p', 'manager', 'translations',         'read'),
  ('p', 'manager', 'checklists',           'read'),
  ('p', 'manager', 'checklists',           'create'),
  ('p', 'manager', 'checklists',           'update'),
  ('p', 'manager', 'approvals',            'read'),
  ('p', 'manager', 'approvals',            'update'),
  ('p', 'manager', 'leave',                'read'),
  ('p', 'manager', 'leave',                'update'),
  ('p', 'manager', 'time-tracking',        'read'),
  ('p', 'manager', 'assets',               'read'),
  ('p', 'manager', 'assets',               'update'),
  ('p', 'manager', 'pos',                  'read'),
  ('p', 'manager', 'pos',                  'create'),
  ('p', 'manager', 'pos',                  'update')
ON CONFLICT (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, '')) DO NOTHING;

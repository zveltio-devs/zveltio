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
  ('p', 'employee', 'leave',                'create'),
  ('p', 'employee', 'leave',                'read'),
  ('p', 'employee', 'time-tracking',        'read'),
  ('p', 'employee', 'time-tracking',        'create'),
  ('p', 'employee', 'assets',               'read'),
  ('p', 'employee', 'pos',                  'read')
ON CONFLICT DO NOTHING;

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
ON CONFLICT DO NOTHING;

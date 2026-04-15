-- Migration: 058_client_portal
-- Business-domain portal tables removed — replaced by the Zones/Pages/Views system (060).
-- Only role + permissions bootstrapping kept.

-- Add client role
INSERT INTO zv_roles (name, description)
VALUES ('client', 'Client portal user — access to the client portal zone')
ON CONFLICT (name) DO NOTHING;

-- Casbin: client role can access portal resources
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'client', 'portal', 'read'),
  ('p', 'client', 'portal', 'write')
ON CONFLICT DO NOTHING;

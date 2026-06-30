-- Standard tenant-role policies (beta.22). These define what each tenant role
-- CAN do; they live at domain '*' so they apply wherever a user holds the role.
-- Per-tenant membership (/api/tenants/:id/members) grants a user a tenant role IN
-- a specific tenant's domain (g, user, tenant_<role>, <tenantId>), scoping the
-- permission to that tenant.
--
-- The Casbin role names are NAMESPACED (`tenant_*`) so they never collide with —
-- or escalate — the pre-existing global roles (`admin`, `member`) seeded in 001.
--
-- 4-token layout (post-008): p = sub(role), dom, obj, act.

INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
  ('p', 'tenant_owner',  '*', '*', '*'),
  ('p', 'tenant_admin',  '*', '*', '*'),
  ('p', 'tenant_member', '*', '*', 'read'),
  ('p', 'tenant_member', '*', '*', 'create'),
  ('p', 'tenant_member', '*', '*', 'update'),
  ('p', 'tenant_viewer', '*', '*', 'read')
ON CONFLICT DO NOTHING;

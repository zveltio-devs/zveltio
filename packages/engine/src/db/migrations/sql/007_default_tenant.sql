-- Multi-tenant foundation (beta.18): the implicit default tenant.
--
-- "Always one tenant" model: every install has a default tenant. Single-tenant
-- deployments resolve to it on every request, so the `zveltio.current_tenant`
-- GUC is always set and RLS is uniform. The fixed UUID matches DEFAULT_TENANT_ID
-- in tenant-manager.ts and the collection-table column default applied by the
-- boot RLS reconciler.

INSERT INTO zv_tenants (id, slug, name, plan, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default', 'enterprise', 'active')
ON CONFLICT (id) DO NOTHING;

-- Backfill the built-in tenant-scoped content tables so existing rows belong to
-- the default tenant (otherwise FORCE RLS would hide them once enabled).
UPDATE zvd_pages SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE zvd_views SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE zvd_zones SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

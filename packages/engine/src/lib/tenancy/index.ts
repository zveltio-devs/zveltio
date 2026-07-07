// Tenancy subsystem — the multi-tenant core: per-request tenant context, tenant
// manager, row-level security (RLS) filters, entity-level access, column
// permissions, and the RBAC/permissions engine. Public API; outside (non-test)
// code imports from `lib/tenancy`, never the deep files. Grouped by H-08.
export * from './tenant-context.js';
export * from './tenant-manager.js';
export * from './rls.js';
export * from './entity-access.js';
export * from './column-permissions.js';
export * from './permissions.js';

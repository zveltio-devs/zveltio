-- 049_edge_functions_rls.sql
--
-- Row-level security for zv_edge_functions and zv_edge_function_logs.
--
-- Migration 015 gave both tables a `tenant_id`, a GUC-backed DEFAULT and a
-- per-tenant UNIQUE, and closed the cross-tenant IDOR it describes — but it
-- closed it in the HANDLERS, and said so: "they run on the request db without
-- relying on RLS". No policy was ever created; verified on a freshly migrated
-- database, where both tables report relrowsecurity = false and zero policies.
--
-- That worked while the handlers were the engine's. Edge-function CRUD now
-- belongs to extensions/developer/edge-functions, and the extension's routes
-- scope by `id`, `path` and `is_active` — never by tenant. Its own comment
-- explains why: "`db` is `ctx.db` … already RLS-scoped — there is one spelling,
-- so there is none to forget." That is true of every other table it could have
-- been written against, and false of exactly these two.
--
-- So the isolation was carried by the copy that moved out, and the assumption
-- that replaced it does not hold here: an admin of one tenant could list, read,
-- patch, delete and INVOKE another tenant's functions — which store secrets in
-- `env_vars` and run arbitrary code — and read their invocation logs.
--
-- Fixed at the database rather than by restoring predicates route by route.
-- Predicates protect the routes someone remembers to write them in, and the bug
-- being fixed is a route that did not. A policy protects the next one too, and
-- it makes the extension's assumption true instead of nearly true.

-- FORCE matters: without it Postgres lets the table owner bypass the policy,
-- and the engine connects as owner on a stock install, so RLS would be
-- advisory. Requests run as the non-bypassing `zveltio_rls` role.
ALTER TABLE zv_edge_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_functions FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs FORCE ROW LEVEL SECURITY;

-- The host's own predicate, matching the column DEFAULT migration 015 already
-- set, so reads and writes cannot disagree. Named `tenant_isolation_*` so the
-- boot reconciler adopts them like every other extension-owned table.
DROP POLICY IF EXISTS tenant_isolation_zv_edge_functions ON zv_edge_functions;
CREATE POLICY tenant_isolation_zv_edge_functions ON zv_edge_functions
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));

DROP POLICY IF EXISTS tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs;
CREATE POLICY tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));

-- Rows written before 015 backfilled, and any written since by a path with no
-- tenant context, would become invisible to everyone rather than visible to
-- everyone. 015 already backfilled; this is the guard for anything after it.
UPDATE zv_edge_functions SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;
UPDATE zv_edge_function_logs SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

-- Deliberately NOT `SET NOT NULL`. It would block reads for the length of a
-- table scan — `zv_edge_function_logs` is the one table here that grows without
-- bound — and it buys nothing: `zveltio_tenant_scope_ok(NULL)` is NULL, so the
-- policy already hides a NULL-tenant row from everyone rather than showing it
-- to everyone, and the DEFAULT above stops new ones appearing.

-- DOWN
DROP POLICY IF EXISTS tenant_isolation_zv_edge_functions ON zv_edge_functions;
DROP POLICY IF EXISTS tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs;
ALTER TABLE zv_edge_functions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_functions DISABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs DISABLE ROW LEVEL SECURITY;

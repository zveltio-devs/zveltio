-- 029_tenant_scope_predicate.sql
--
-- One definition of "may this row be seen in this tenant context".
--
-- There were two, and they disagreed on the case that matters. The engine's own
-- collection tables use
--
--     USING (tenant_id::text = current_setting('zveltio.current_tenant', true))
--
-- which is fail-CLOSED: no tenant context, no rows. Every extension shipped its
-- own `002_tenant_rls.sql` from a copied template that reads
--
--     USING (NULLIF(current_setting(...), '') IS NULL   -- ← every row
--            OR tenant_id IS NULL                       -- ← every row
--            OR tenant_id::text = current_setting(...))
--
-- which is fail-OPEN, in all 54 of them. So a query that reached an extension's
-- table without opening the tenant transaction — and 31 of 53 extensions hold a
-- bare `db` where they meant `reqDb(c)` — read every tenant's rows instead of
-- none. The identical mistake against an engine table returned an empty set and
-- got noticed. Same rule, two spellings, opposite behaviour on the only case
-- anybody cares about.
--
-- The fail-open clause was not an oversight; the template documents it as the
-- "single-tenant fallback", and that intent is real. On an install with no
-- tenant routing there is no middleware transaction and no GUC, so a
-- fail-closed policy returns nothing at all — and self-hosted single-tenant is
-- the primary deployment. Measured on Postgres 18: a straight flip does break
-- it.
--
-- What both spellings missed is that the engine already answers this question
-- elsewhere, in the tenant_id column DEFAULT that migration 007 and
-- tenant-manager.ts install:
--
--     COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
--              '00000000-0000-0000-0000-000000000001'::uuid)
--
-- "the current tenant, and absent context, the default tenant". Rows are
-- WRITTEN under that rule, so reading them under the same rule is the only
-- spelling that cannot disagree with itself. That is all this predicate is.
--
--   GUC set   → the row must belong to that tenant.
--   GUC unset → the row must belong to the DEFAULT tenant. On a single-tenant
--               install that is every row, so nothing changes. On an install
--               with real tenants, a contextless query now reads the default
--               tenant's data instead of everyone's — still a bug in the
--               caller, but no longer a cross-tenant disclosure.
--
-- Rows with a NULL tenant_id become invisible rather than universally visible.
-- The reconciler backfills them to the default tenant first, exactly as
-- migration 007 did for the engine's own tables, so this closes a hole instead
-- of hiding data.
--
-- Written as a function on purpose: the next change to this rule happens in one
-- place instead of in 54 files that will disagree again. Postgres inlines it —
-- the plan shows the bare expression and the buffer count is identical to no
-- policy at all (measured: 200k rows, 1471 buffers either way).

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_tenant = COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  )
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(uuid) IS
  'Single source of truth for tenant row visibility, mirroring the tenant_id '
  'column DEFAULT so reads and writes cannot disagree. Used by tenant_isolation '
  'policies on engine and extension tables alike. See migration 029.';

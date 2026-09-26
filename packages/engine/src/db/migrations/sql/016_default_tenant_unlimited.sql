-- 016_default_tenant_unlimited.sql
--
-- The default tenant was seeded with free-plan limits, so every install stopped
-- answering after 10,000 API calls a day.
--
-- 001 seeds it with `INSERT INTO zv_tenants (id, slug, name, plan, status)` and
-- no limit columns, so it takes the column defaults: 10,000 API calls a day,
-- 10,000 records, 5 users, 1 GB. The engine declares it unlimited everywhere
-- else (DEFAULT_TENANT and the ZVELTIO_TENANT_ID fallback in tenant-manager.ts),
-- but middleware/tenant-quota.ts reads the row, not the sentinel. A single-tenant
-- install runs every request as this tenant, so request 10,001 of the day and
-- every one after it was answered 429 "Daily API quota exceeded. Upgrade your
-- plan" — there is no plan to upgrade to. The nightly soak measured it: 9,994
-- requests OK, then 1,129,245 refusals.
--
-- The values are the sentinel's. Only a column still at its column default is
-- raised, so a limit an operator set on the default tenant is left alone. (An
-- operator who deliberately set a value EQUAL to the default cannot be told
-- apart from the seed, and is raised too.)
--
-- Why not fix the seed in 001 instead: an applied migration is checksummed, and
-- `assertChainCompatible` refuses to boot when a shipped file no longer matches
-- what the database recorded. Editing 001 would stop every existing install from
-- starting, and they are exactly the installs this repairs. Fresh installs run
-- this file right after 001, so they are covered too.
--
-- Non-default tenants keep their limits: those are per-customer plan values an
-- operator sets through PATCH /api/tenants/:id.

UPDATE zv_tenants SET
  max_api_calls_day = CASE WHEN max_api_calls_day = 10000 THEN 2147483647 ELSE max_api_calls_day END,
  max_records       = CASE WHEN max_records = 10000 THEN 2147483647 ELSE max_records END,
  max_users         = CASE WHEN max_users = 5 THEN 2147483647 ELSE max_users END,
  max_storage_gb    = CASE WHEN max_storage_gb = 1.0 THEN 999999 ELSE max_storage_gb END
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND (max_api_calls_day = 10000 OR max_records = 10000 OR max_users = 5 OR max_storage_gb = 1.0);

-- DOWN

-- Deliberately empty. Putting the default tenant back on 10,000 calls a day
-- reintroduces the outage this repairs, and a rollback that reintroduces the
-- defect is not a rollback.

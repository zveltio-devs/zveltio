-- 028_webhooks_rls.sql
--
-- `zvd_webhooks` and `zvd_webhook_deliveries` go under the tenant policy every
-- tenant table has.
--
-- 016 gave both `tenant_id` and no policy. What kept one firm out of another's
-- webhooks — URLs, custom headers, delivered payloads — was the `where
-- tenant_id = …` each `/api/webhooks` handler and the dispatcher remembered; a
-- whitelisted RPC function, or any reader that forgets, saw every firm's.
--
-- `/api/webhooks` and `/api/admin/stats` already run in the request's tenant
-- transaction. Every other reader ran on the pool, where a policed table answers
-- for the default firm only on a non-superuser database, so each moves with it:
--   * The dispatcher (`WebhookManager.trigger`) looks up the writing firm's
--     webhooks and records the delivery inside that firm's `withTenantIsolation`.
--   * The outcome and retry count written after each attempt go in as the
--     delivery's firm, which now rides on the queued payload.
--   * The boot repair of unsigned webhooks reads every firm (`withEveryTenant`)
--     and writes each row as its own firm.
--   * The `/metrics` gauges count every firm (`withEveryTenant`).
-- No extension reads either table (`api-connector`'s `zvd_webhook_events` is
-- its own, and policed by its own migration).

-- A NULL tenant_id is invisible to everyone under the policy. 016 backfilled
-- the columns already; this catches a row written with an explicit NULL.
UPDATE zvd_webhooks SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;
UPDATE zvd_webhook_deliveries SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zvd_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE zvd_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_webhook_deliveries FORCE ROW LEVEL SECURITY;

-- The shape the boot reconciler gives every `tenant_isolation_*` policy
-- (005: the `(SELECT …)` InitPlan; 004: writes to the own node only).
DROP POLICY IF EXISTS tenant_isolation_zvd_webhooks ON zvd_webhooks;
CREATE POLICY tenant_isolation_zvd_webhooks ON zvd_webhooks AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

DROP POLICY IF EXISTS tenant_isolation_zvd_webhook_deliveries ON zvd_webhook_deliveries;
CREATE POLICY tenant_isolation_zvd_webhook_deliveries ON zvd_webhook_deliveries
  AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- DOWN

DROP POLICY IF EXISTS tenant_isolation_zvd_webhook_deliveries ON zvd_webhook_deliveries;
ALTER TABLE zvd_webhook_deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zvd_webhook_deliveries DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_zvd_webhooks ON zvd_webhooks;
ALTER TABLE zvd_webhooks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zvd_webhooks DISABLE ROW LEVEL SECURITY;

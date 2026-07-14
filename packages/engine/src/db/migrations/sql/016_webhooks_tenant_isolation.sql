-- Migration 016: tenant isolation for webhooks.
--
-- zvd_webhooks / zvd_webhook_deliveries had no tenant_id, so:
--   1. routes/webhooks.ts (raw pool, admin-gated but admin is PER-TENANT) listed
--      EVERY tenant's webhooks and let GET/PATCH/DELETE/test/rotate-secret reach
--      another tenant's webhook by id → cross-tenant IDOR (config + rotate-secret
--      returns the plaintext signing key).
--   2. WORSE — lib/webhooks.ts WebhookManager.trigger() selected matching
--      webhooks across ALL tenants, so a data write in tenant A fired tenant B's
--      webhook → B's endpoint received A's record data (cross-tenant data
--      exfiltration).
-- Add tenant_id (NULLIF-guarded default) + backfill; the route scopes every
-- read/write by the request tenant and the dispatcher filters by the writing
-- tenant (threaded from afterWrite, same as the WS/SSE broadcasts).

ALTER TABLE zvd_webhooks ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zvd_webhooks SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zvd_webhooks ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zvd_webhooks_tenant ON zvd_webhooks(tenant_id);

ALTER TABLE zvd_webhook_deliveries ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zvd_webhook_deliveries SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zvd_webhook_deliveries ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_tenant ON zvd_webhook_deliveries(tenant_id);

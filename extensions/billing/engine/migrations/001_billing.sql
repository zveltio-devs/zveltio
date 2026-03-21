CREATE TABLE IF NOT EXISTS zv_billing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  stripe_price_id TEXT,
  limits JSONB NOT NULL DEFAULT '{}',  -- {api_calls: 10000, storage_mb: 1000, records: 50000}
  price_cents INTEGER NOT NULL DEFAULT 0,
  interval TEXT NOT NULL DEFAULT 'month',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  event_type TEXT NOT NULL,  -- 'api_call', 'storage_write', 'record_created', 'webhook_delivery'
  collection TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant ON zv_usage_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_type ON zv_usage_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS zv_billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  plan_id UUID REFERENCES zv_billing_plans(id),
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

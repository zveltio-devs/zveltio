-- Migration 006: Webhooks system

CREATE TABLE IF NOT EXISTS zvd_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT DEFAULT 'POST' CHECK (method IN ('POST', 'PUT', 'PATCH')),
  headers JSONB DEFAULT '{}',
  events TEXT[] NOT NULL,
  collections TEXT[],
  active BOOLEAN DEFAULT true,
  secret TEXT,
  retry_attempts INTEGER DEFAULT 3 CHECK (retry_attempts >= 0 AND retry_attempts <= 10),
  timeout INTEGER DEFAULT 5000 CHECK (timeout >= 1000 AND timeout <= 30000),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zvd_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES zvd_webhooks(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  headers JSONB DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status INTEGER,
  response_body TEXT,
  error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_webhooks_active
  ON zvd_webhooks(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_webhook
  ON zvd_webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_created
  ON zvd_webhook_deliveries(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zvd_webhook_deliveries_created;
DROP INDEX IF EXISTS idx_zvd_webhook_deliveries_webhook;
DROP TABLE IF EXISTS zvd_webhook_deliveries;
DROP INDEX IF EXISTS idx_zvd_webhooks_active;
DROP TABLE IF EXISTS zvd_webhooks;

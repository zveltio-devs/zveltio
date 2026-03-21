CREATE TABLE IF NOT EXISTS zv_sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'twilio',
  to_number TEXT NOT NULL,
  from_number TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, delivered, failed
  provider_message_id TEXT,
  error TEXT,
  metadata JSONB DEFAULT '{}',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_status ON zv_sms_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_to ON zv_sms_messages(to_number, created_at DESC);

CREATE TABLE IF NOT EXISTS zv_sms_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  body TEXT NOT NULL,  -- supports {{variable}} interpolation
  provider TEXT NOT NULL DEFAULT 'twilio',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

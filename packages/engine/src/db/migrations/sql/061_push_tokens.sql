-- Mobile push notification device tokens
CREATE TABLE IF NOT EXISTS zvd_push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  token       text NOT NULL,
  platform    text NOT NULL CHECK (platform IN ('fcm', 'apns', 'web')),
  device_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON zvd_push_tokens (user_id);

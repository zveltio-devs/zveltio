-- Migration 007: In-app notifications

CREATE TABLE IF NOT EXISTS zv_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'success', 'warning', 'error')),
  action_url TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  source TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON zv_notifications(user_id, is_read, created_at DESC);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS zv_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON zv_push_subscriptions(user_id);

-- DOWN
DROP INDEX IF EXISTS idx_push_subscriptions_user;
DROP TABLE IF EXISTS zv_push_subscriptions;
DROP INDEX IF EXISTS idx_notifications_user;
DROP TABLE IF EXISTS zv_notifications;

-- Migration 012: Record comments (threaded comments on any record)

CREATE TABLE IF NOT EXISTS zv_record_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  comment TEXT NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES zv_record_comments(id) ON DELETE CASCADE,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_record_comments_record
  ON zv_record_comments(collection, record_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_zv_record_comments_user
  ON zv_record_comments(user_id);

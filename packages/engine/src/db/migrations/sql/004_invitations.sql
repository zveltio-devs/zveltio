-- Migration: 004_invitations
--
-- Adds the missing zv_invitations table. The POST /api/users/invite
-- route was already INSERTing into it and the response URL pointed at
-- /accept-invite?token=…, but no migration ever created the table and
-- no route handled the accept side. Every invite would hit the catch
-- block ("Table may not exist yet — fall back to returning the
-- token directly") which made the flow look graceful from the API
-- response but actually meant nothing was ever persisted and the
-- token was useless against the (also missing) accept endpoint.
--
-- This migration creates the storage. A companion route
-- POST /api/auth/accept-invite consumes the rows.

CREATE TABLE IF NOT EXISTS zv_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  invited_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_invitations_token   ON zv_invitations(token);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_email   ON zv_invitations(email);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_expires ON zv_invitations(expires_at)
  WHERE accepted_at IS NULL;

-- Audit log for marketplace license / token operations (S3-04).
--
-- Today the engine stores a single `marketplace_auth_token` in zv_settings.
-- If it ever leaks, an admin can call POST /api/admin/license/rotate to mint
-- a new one — every rotation lands here so leaks have a paper trail.
-- Per-extension license keys (zv_settings ext_license:<name>) flow through
-- the same audit when their lifecycle endpoints fire.

CREATE TABLE IF NOT EXISTS zv_license_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'rotate' | 'set' | 'delete'. Free-form for forward compatibility.
  action          TEXT NOT NULL,
  -- Which license this affects. NULL for the marketplace token itself.
  extension_name  TEXT,
  -- Who triggered it (user.id from session) — NULL only if invoked via CLI
  -- with a service-level token, which today is not implemented.
  performed_by    TEXT,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Source IP + UA for forensics. Both may be NULL behind reverse proxies
  -- if the engine isn't trusting X-Forwarded-For.
  ip              TEXT,
  user_agent      TEXT,
  -- Free-form JSON for action-specific context (e.g. old_token_fingerprint).
  -- Avoid storing the new token here in plaintext.
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_zv_license_audit_performed_at
  ON zv_license_audit (performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_zv_license_audit_extension
  ON zv_license_audit (extension_name, performed_at DESC)
  WHERE extension_name IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS idx_zv_license_audit_extension;
DROP INDEX IF EXISTS idx_zv_license_audit_performed_at;
DROP TABLE IF EXISTS zv_license_audit;

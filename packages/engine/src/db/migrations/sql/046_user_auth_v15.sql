-- 051_user_auth_v15.sql
-- Compatibility fixes for better-auth v1.5:
--   1. Add twoFactorEnabled (twoFactor plugin adds this field to user SELECT queries)
--   2. Expand role CHECK constraint to include 'god'

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Drop the inline-generated CHECK constraint on role (name: user_role_check)
-- and recreate it to include 'god'.
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'admin', 'manager', 'member'));

-- DOWN
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('admin', 'manager', 'member'));
ALTER TABLE "user" DROP COLUMN IF EXISTS "twoFactorEnabled";

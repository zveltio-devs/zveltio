-- Simplify user.role to only 'god' | 'member'.
-- All other roles (admin, manager, employee, client, etc.) are Casbin-only concepts.

-- Migrate any legacy 'admin' or 'manager' DB role values to 'member'
UPDATE "user" SET role = 'member' WHERE role IN ('admin', 'manager');

-- Rebuild the CHECK constraint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'member'));

-- DOWN
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'admin', 'manager', 'member'));

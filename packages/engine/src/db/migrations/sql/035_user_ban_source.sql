-- 035_user_ban_source.sql
--
-- Who placed a sign-in block, and when.
--
-- `"user".banned` (020) is a bare flag. An extension that blocks a user and
-- later wants to lift ONLY its own block could not tell its ban from an
-- administrator's, so auth/scim kept its own marker table and hooked "user"
-- with a trigger to forget the marker when anyone lifted the ban (SCIM 004).
-- The engine owns the provenance now:
--
--   ban_source — `ext:<name>` when an extension's `ctx.internals.setUserActive`
--                placed the ban (the host binds the name; an extension cannot
--                pass one), `unknown` for any other ban: raw SQL, better-auth's
--                admin plugin, or a ban older than this migration. NULL iff not
--                banned.
--   banned_at  — when it was placed. NULL for a ban older than this migration:
--                its time was never recorded, and now() would be a guess.
--
-- `liftOwnBan` lifts a ban only when `ban_source` is the caller's. The first
-- ban stands: banning an account that is already banned keeps the original
-- source (`setUserActive` touches only an unbanned row).
--
-- THE INVARIANT LIVES ON THE TABLE
--
-- A trigger, not a CHECK. A CHECK would refuse `UPDATE "user" SET banned = true`
-- by hand, and better-auth's admin plugin, which knows nothing of these columns.
-- The trigger instead fills `unknown` for a ban placed without a source and
-- clears both columns whenever the ban is lifted, by whoever. That second half
-- is what matters: a hand-lifted ban that kept `ext:auth/scim`, then a hand-
-- placed ban over it, would let SCIM lift an administrator's ban — the exact
-- bug SCIM 004's trigger exists for.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ban_source TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

UPDATE "user" SET ban_source = 'unknown' WHERE banned IS TRUE AND ban_source IS NULL;

-- auth/scim ≤ 1.0.15 recorded its own bans in `zv_scim_sign_in_blocks`, and
-- (SCIM 004) a row there means the CURRENT ban is SCIM's. Absent when SCIM was
-- never installed. The table carries no RLS.
DO $$
BEGIN
  IF to_regclass('public.zv_scim_sign_in_blocks') IS NOT NULL THEN
    UPDATE "user" u SET ban_source = 'ext:auth/scim'
      FROM public.zv_scim_sign_in_blocks b
     WHERE b.user_id = u.id AND u.banned IS TRUE;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION zveltio_user_ban_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.banned IS NOT TRUE THEN
    NEW.ban_source := NULL;
    NEW.banned_at := NULL;
  ELSE
    NEW.ban_source := COALESCE(NEW.ban_source, 'unknown');
    IF TG_OP = 'INSERT' OR OLD.banned IS NOT TRUE THEN
      NEW.banned_at := COALESCE(NEW.banned_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zv_user_ban_source ON "user";
CREATE TRIGGER zv_user_ban_source
  BEFORE INSERT OR UPDATE OF banned, ban_source, banned_at ON "user"
  FOR EACH ROW EXECUTE FUNCTION zveltio_user_ban_source();

-- DOWN

DROP TRIGGER IF EXISTS zv_user_ban_source ON "user";
DROP FUNCTION IF EXISTS zveltio_user_ban_source();
ALTER TABLE "user" DROP COLUMN IF EXISTS banned_at;
ALTER TABLE "user" DROP COLUMN IF EXISTS ban_source;

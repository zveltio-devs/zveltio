-- One god per instance, and the database is what says so.
--
-- The model is: exactly one god on the instance — the account that installs
-- extensions and can act anywhere — with per-firm administrators beneath it.
-- Nothing enforced that. `user.role` accepts 'god' on any number of rows, and
-- the only thing standing between an instance and a second god was that nobody
-- had made one yet.
--
-- ── Why a trigger and not a unique index ──────────────────────
--
-- `CREATE UNIQUE INDEX … WHERE role = 'god'` is the obvious spelling and it is
-- the wrong one HERE, because it fails the migration outright on any install
-- that already has two. That install is then stuck: it cannot upgrade, and the
-- fix it needs (decide which account keeps the role) is a decision no migration
-- may take on an operator's behalf — demoting the wrong one silently removes
-- someone's access.
--
-- So the trigger refuses to create a SECOND god from here on, and an install
-- that already has several keeps working while an operator sorts it out. The
-- unique index becomes possible once the fleet is clean; it is not the thing to
-- reach for while it is not.
--
-- The check runs on INSERT and on UPDATE, and only when the row it is about to
-- write is a god — a member being renamed pays nothing.

CREATE OR REPLACE FUNCTION zveltio_one_god_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other_god text;
BEGIN
  IF NEW.role IS DISTINCT FROM 'god' THEN
    RETURN NEW;
  END IF;
  -- An UPDATE that leaves an existing god a god is not a second god.
  IF TG_OP = 'UPDATE' AND OLD.role = 'god' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO other_god FROM "user" WHERE role = 'god' AND id <> NEW.id LIMIT 1;
  IF other_god IS NOT NULL THEN
    RAISE EXCEPTION
      'this instance already has a god (%): there is exactly one, and it is the account that installs extensions and may act in any firm. Demote it first, or grant this user a per-firm administrator role instead.',
      other_god
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zv_one_god_only ON "user";
CREATE TRIGGER zv_one_god_only
  BEFORE INSERT OR UPDATE OF role ON "user"
  FOR EACH ROW EXECUTE FUNCTION zveltio_one_god_only();

-- Say something if this install is already past the invariant. A migration that
-- cannot fix a thing should at least name it.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM "user" WHERE role = 'god';
  IF n > 1 THEN
    RAISE WARNING
      'this instance has % accounts with role=god. New ones are refused from now on, but the existing ones are left alone: choosing which keeps it is an operator decision, not a migration''s.',
      n;
  END IF;
END;
$$;

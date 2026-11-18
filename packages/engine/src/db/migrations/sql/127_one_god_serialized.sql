-- 127_one_god_serialized.sql
--
-- Migration 008's `zveltio_one_god_only` asked "is there another god?" under
-- the writer's own snapshot. Two transactions promoting different users on an
-- instance with no god each saw none, and both committed: two gods. Only
-- createFirstAdmin serialized itself (an advisory lock in lib/first-admin.ts);
-- the recovery bootstrap and any other writer of `user.role` did not.
--
-- The check now takes a transaction-scoped advisory lock first, so a second
-- promotion waits until the first commits or rolls back. Under READ COMMITTED
-- (every engine writer) the SELECT after the lock runs on a fresh snapshot,
-- sees the committed god, and refuses with the same message and SQLSTATE as
-- before. Only a write that MAKES a god takes the lock; a member pays nothing.
--
-- Still a trigger, not `UNIQUE … WHERE role = 'god'`, for 008's reason: an
-- install that already has two would fail the migration outright.
-- ponytail: a REPEATABLE READ transaction keeps its old snapshot after the lock,
-- so it can still add a second god; no engine path writes `role` under RR.
-- The unique index closes that too, once the fleet has no multi-god install.

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

  -- Held until this transaction ends: a concurrent promotion queues here.
  PERFORM pg_advisory_xact_lock(hashtext('zveltio:one-god'));

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

-- DOWN
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

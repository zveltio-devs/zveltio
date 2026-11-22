-- 132_rule_object_locked.sql
--
-- ADR 0002 step 5, under concurrency: a rule does not outlive its object.
--
-- 116's trigger asked `zveltio_rule_object_exists`, a plain read. Under READ
-- COMMITTED it sees the collection row as last committed, so a rule written
-- while a drop was open — after the drop had deleted the collection's rules,
-- before it committed — passed, committed, and stayed: a collection created
-- again under the name inherited it (rules-live-with-their-object.test.ts).
--
-- The trigger now locks the row it relies on, `FOR KEY SHARE`, as a foreign key
-- does: the write waits for an open drop, then finds the row gone and is
-- refused; a drop that starts later waits for the write and deletes its rule.
-- `zveltio_rule_object_exists` stays the read a schema plan asks.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.zveltio_refuse_rule_without_object() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  obj text;
BEGIN
  IF TG_TABLE_NAME = 'zvd_permissions' THEN
    IF NEW.ptype IS DISTINCT FROM 'p' THEN
      RETURN NEW;
    END IF;
    obj := NEW.v2;
  ELSE
    obj := NEW.resource;
  END IF;
  IF obj IN ('*', 'admin', 'data', '$edge') THEN
    RETURN NEW;
  END IF;
  IF starts_with(obj, '$ext:') THEN
    PERFORM 1 FROM public.zv_extension_registry WHERE name = substr(obj, 6) FOR KEY SHARE;
  ELSE
    PERFORM 1 FROM public.zvd_collections WHERE name = obj FOR KEY SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A rule names "%", which is not *, an engine object, a registered extension or an existing collection', obj
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- DOWN
CREATE OR REPLACE FUNCTION public.zveltio_refuse_rule_without_object() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  obj text;
BEGIN
  IF TG_TABLE_NAME = 'zvd_permissions' THEN
    IF NEW.ptype IS DISTINCT FROM 'p' THEN
      RETURN NEW;
    END IF;
    obj := NEW.v2;
  ELSE
    obj := NEW.resource;
  END IF;
  IF public.zveltio_rule_object_exists(obj) IS NOT TRUE THEN
    RAISE EXCEPTION 'A rule names "%", which is not *, an engine object, a registered extension or an existing collection', obj
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

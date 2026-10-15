-- 078_drop_inherit_down.sql
--
-- Downward inheritance, removed before rc.1 freezes the contract.
--
-- 004 added `zvd_collections.inherit_down` ("rows written at an ancestor unit
-- are readable from below") with its machinery: the two-argument
-- `zveltio_tenant_scope_ok(row_tenant, inherit_down)` overloads,
-- `zveltio_ancestor_tenants()` / `_text()` reading a `zveltio.ancestor_tenants`
-- GUC, and an ancestor walk in `zveltio_tenant_reach` (057) that every
-- authenticated request paid for. Nothing ever compiled the flag into a policy:
-- no API sets it, no engine or extension policy calls the two-argument
-- overloads or the ancestor sets. Setting the column granted nothing, and the
-- walk fed a GUC no policy read. Re-add it end to end if it is ever needed.
--
-- Dropped without CASCADE on purpose: a hand-written policy that calls one of
-- these functions makes the migration fail and names it, instead of losing it.
--
-- `zveltio_tenant_ancestors(uuid)` goes too: the reach was its only caller (the
-- cycle trigger walks `parent_id` itself; `subtree` and `org` do not look up).
--
-- `zveltio_tenant_reach` keeps its `ancestors_csv` OUT column, always NULL and
-- unread: a replica of the previous release still selects it on every
-- authenticated request during a rolling upgrade (and coalesces NULL to ''), so
-- dropping it would fail all of them until the rollout ends. It goes with the
-- next squash, as 071's column does. Replaced in place, so owner, grants,
-- volatility and parallel safety are unchanged; the 069 search_path is restated
-- because CREATE OR REPLACE resets what it does not repeat.
--
-- squawk: the column drop is safe for that replica too — it reads
-- `zvd_collections` with `SELECT *` and writes `inherit_down` nowhere.

-- squawk-ignore-file ban-drop-column

CREATE OR REPLACE FUNCTION zveltio_tenant_reach(
  p_user text,
  p_tenant text,
  OUT visible_csv text,
  OUT ancestors_csv text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := p_tenant::uuid;
  v_total int;
  v_live int;
  v_widest int;
  v_set text[];
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())),
         coalesce(max(CASE u.read_scope WHEN 'org' THEN 3 WHEN 'subtree' THEN 2
                                        WHEN 'list' THEN 1 ELSE 0 END)
                  FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())), 0)
    INTO v_total, v_live, v_widest
    FROM zv_tenant_users u
   WHERE u.user_id = p_user AND u.tenant_id = v_tenant;

  IF v_total = 0 THEN
    visible_csv := NULL;
    RETURN;
  END IF;
  IF v_live = 0 THEN
    visible_csv := '00000000-0000-0000-0000-000000000000';
    RETURN;
  END IF;

  IF v_widest = 3 THEN
    SELECT coalesce(string_agg(t.id::text, ','), '') INTO visible_csv FROM zv_tenants t;
    RETURN;
  ELSIF v_widest = 2 THEN
    v_set := ARRAY(SELECT s::text FROM zveltio_tenant_subtree(v_tenant) AS s);
  ELSIF v_widest = 1 THEN
    v_set := ARRAY(
      SELECT e::text
        FROM zv_tenant_users l, unnest(l.scope_list) AS e
       WHERE l.user_id = p_user AND l.tenant_id = v_tenant AND l.read_scope = 'list'
         AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
    );
  ELSE
    visible_csv := p_tenant;
    RETURN;
  END IF;

  -- First occurrence wins, so the own unit stays first.
  SELECT string_agg(z.id, ',' ORDER BY z.o)
    INTO visible_csv
    FROM (
      SELECT x.id, min(x.o) AS o
        FROM unnest(ARRAY[p_tenant] || v_set) WITH ORDINALITY AS x(id, o)
       WHERE x.id IS NOT NULL AND x.id <> ''
       GROUP BY x.id
    ) z;
END;
$$;

COMMENT ON FUNCTION zveltio_tenant_reach(text, text) IS
  'The read reach of a user in a unit, as the GUC spelling: visible_csv (NULL = publish no set). ancestors_csv is always NULL and unread (078), kept for previous-release replicas. Called by withTenantIsolation before it drops to zveltio_rls.';

DROP FUNCTION IF EXISTS zveltio_tenant_ancestors(uuid);
DROP FUNCTION IF EXISTS zveltio_tenant_scope_ok(uuid, boolean);
DROP FUNCTION IF EXISTS zveltio_tenant_scope_ok(text, boolean);
DROP FUNCTION IF EXISTS zveltio_ancestor_tenants();
DROP FUNCTION IF EXISTS zveltio_ancestor_tenants_text();

ALTER TABLE zvd_collections DROP COLUMN IF EXISTS inherit_down;

-- DOWN

-- 004's and 057's definitions (with 069's search_path). The column comes back
-- false everywhere; it was false everywhere, since nothing ever set it.

ALTER TABLE zvd_collections
  ADD COLUMN IF NOT EXISTS inherit_down BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN zvd_collections.inherit_down IS
  'Rows written at an ancestor unit are readable from below. Off by default: '
  'head-office payroll does not become county-visible merely by sitting higher. '
  'Upward visibility is NOT a per-collection flag — it is governed by read_scope '
  'on the assignment and by Casbin on the resource.';

CREATE OR REPLACE FUNCTION zveltio_ancestor_tenants()
RETURNS uuid[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.ancestor_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.ancestor_tenants', true), ',')::uuid[]
    ELSE ARRAY[]::uuid[]
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_ancestor_tenants_text()
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.ancestor_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.ancestor_tenants', true), ',')
    ELSE ARRAY[]::text[]
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid, inherit_down boolean)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT row_tenant = ANY (zveltio_visible_tenants())
      OR (inherit_down AND row_tenant = ANY (zveltio_ancestor_tenants()))
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text, inherit_down boolean)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT row_tenant = ANY (zveltio_visible_tenants_text())
      OR (inherit_down AND row_tenant = ANY (zveltio_ancestor_tenants_text()))
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_ancestors(node uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE walk(id, parent_id, depth) AS (
    SELECT t.id, t.parent_id, 0 FROM zv_tenants t WHERE t.id = node
    UNION ALL
    SELECT p.id, p.parent_id, w.depth + 1
      FROM zv_tenants p JOIN walk w ON p.id = w.parent_id
     WHERE w.depth < 64
  )
  SELECT id FROM walk WHERE id <> node
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_reach(
  p_user text,
  p_tenant text,
  OUT visible_csv text,
  OUT ancestors_csv text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := p_tenant::uuid;
  v_total int;
  v_live int;
  v_widest int;
  v_set text[];
BEGIN
  SELECT coalesce(string_agg(a::text, ','), '')
    INTO ancestors_csv
    FROM zveltio_tenant_ancestors(v_tenant) AS a
   WHERE a IS NOT NULL;

  SELECT count(*),
         count(*) FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())),
         coalesce(max(CASE u.read_scope WHEN 'org' THEN 3 WHEN 'subtree' THEN 2
                                        WHEN 'list' THEN 1 ELSE 0 END)
                  FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())), 0)
    INTO v_total, v_live, v_widest
    FROM zv_tenant_users u
   WHERE u.user_id = p_user AND u.tenant_id = v_tenant;

  IF v_total = 0 THEN
    visible_csv := NULL;
    RETURN;
  END IF;
  IF v_live = 0 THEN
    visible_csv := '00000000-0000-0000-0000-000000000000';
    RETURN;
  END IF;

  IF v_widest = 3 THEN
    SELECT coalesce(string_agg(t.id::text, ','), '') INTO visible_csv FROM zv_tenants t;
    RETURN;
  ELSIF v_widest = 2 THEN
    v_set := ARRAY(SELECT s::text FROM zveltio_tenant_subtree(v_tenant) AS s);
  ELSIF v_widest = 1 THEN
    v_set := ARRAY(
      SELECT e::text
        FROM zv_tenant_users l, unnest(l.scope_list) AS e
       WHERE l.user_id = p_user AND l.tenant_id = v_tenant AND l.read_scope = 'list'
         AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
    );
  ELSE
    visible_csv := p_tenant;
    RETURN;
  END IF;

  -- First occurrence wins, so the own unit stays first.
  SELECT string_agg(z.id, ',' ORDER BY z.o)
    INTO visible_csv
    FROM (
      SELECT x.id, min(x.o) AS o
        FROM unnest(ARRAY[p_tenant] || v_set) WITH ORDINALITY AS x(id, o)
       WHERE x.id IS NOT NULL AND x.id <> ''
       GROUP BY x.id
    ) z;
END;
$$;

COMMENT ON FUNCTION zveltio_tenant_reach(text, text) IS
  'The read reach of a user in a unit, as the GUC spelling: visible_csv (NULL = publish no set) and ancestors_csv. Called by withTenantIsolation before it drops to zveltio_rls.';

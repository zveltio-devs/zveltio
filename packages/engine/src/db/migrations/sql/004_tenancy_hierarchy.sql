-- 003_tenancy_hierarchy.sql
--
-- Units become a tree, and reading stops being the same question as writing.
--
-- See docs/private/TENANCY-HIERARCHY-DESIGN.md for the model and
-- docs/private/TENANCY-COVERAGE-CLASSIFICATION.md for why exactly five tables
-- gain a policy here and eleven others deliberately do not.
--
-- Additive throughout: no row moves, no `tenant_id` changes value, and an
-- installation that never sets the new GUCs behaves exactly as it does today.
-- That last property is the whole migration strategy and it is load-bearing —
-- background workers, migrations and single-tenant installs all run with no
-- tenant context at all, and every one of them must keep working.

-- ── 1. The tree ────────────────────────────────────────────────────

ALTER TABLE zv_tenants
  ADD COLUMN IF NOT EXISTS parent_id   UUID,
  ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merged_into UUID;

-- The two references are added NOT VALID and validated as a second step, rather
-- than inline on the ADD COLUMN.
--
-- Inline, Postgres validates by scanning the table while holding SHARE ROW
-- EXCLUSIVE on it — and `zv_tenants` is read during tenant resolution on every
-- single request. The scan itself is nothing here (both columns are brand new,
-- so every existing row is NULL and satisfies the constraint trivially), but
-- "the table is small" is an argument that stops being true quietly. NOT VALID
-- takes a brief ACCESS EXCLUSIVE and no scan; VALIDATE CONSTRAINT then takes
-- only SHARE UPDATE EXCLUSIVE, which does not block writes. Same constraint at
-- the end, fully valid, without the lock that blocks the request path.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zv_tenants_parent_id_fkey') THEN
    ALTER TABLE zv_tenants ADD CONSTRAINT zv_tenants_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES zv_tenants(id) NOT VALID;
    ALTER TABLE zv_tenants VALIDATE CONSTRAINT zv_tenants_parent_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zv_tenants_merged_into_fkey') THEN
    ALTER TABLE zv_tenants ADD CONSTRAINT zv_tenants_merged_into_fkey
      FOREIGN KEY (merged_into) REFERENCES zv_tenants(id) NOT VALID;
    ALTER TABLE zv_tenants VALIDATE CONSTRAINT zv_tenants_merged_into_fkey;
  END IF;
END $$;

COMMENT ON COLUMN zv_tenants.parent_id IS
  'Parent unit. NULL = a root. Depth is arbitrary.';
COMMENT ON COLUMN zv_tenants.closed_at IS
  'A unit is never deleted. Dissolution sets this; historical rows keep pointing at a node that still exists.';
COMMENT ON COLUMN zv_tenants.merged_into IS
  'Where this unit''s work continued after closure. Read with closed_at.';

CREATE INDEX IF NOT EXISTS idx_zv_tenants_parent_id ON zv_tenants(parent_id);

-- A cycle is not a data-quality problem here, it is a hang: every ancestor and
-- subtree walk below is recursive, and `WITH RECURSIVE` over a cycle without a
-- depth guard returns rows forever. Refusing the write is the only place this
-- can be caught once instead of in each walker.
CREATE OR REPLACE FUNCTION zveltio_tenant_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  walker uuid;
  depth  int := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'tenant % cannot be its own parent', NEW.id;
  END IF;
  walker := NEW.parent_id;
  WHILE walker IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 64 THEN
      RAISE EXCEPTION 'tenant hierarchy deeper than 64 levels at %, refusing', NEW.id;
    END IF;
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'tenant % would form a parent cycle', NEW.id;
    END IF;
    SELECT parent_id INTO walker FROM zv_tenants WHERE id = walker;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zv_tenants_no_cycle ON zv_tenants;
CREATE TRIGGER zv_tenants_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON zv_tenants
  FOR EACH ROW EXECUTE FUNCTION zveltio_tenant_no_cycle();

-- ── 2. Assignments gain a reach and a validity ─────────────────────

ALTER TABLE zv_tenant_users
  ADD COLUMN IF NOT EXISTS read_scope TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS scope_list UUID[],
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- `DEFAULT 'self'` is what makes this migration invisible to existing users:
-- reach `self` resolves to the single unit they are assigned to, which is what
-- an equality predicate already gave them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zv_tenant_users_read_scope_check'
  ) THEN
    ALTER TABLE zv_tenant_users
      ADD CONSTRAINT zv_tenant_users_read_scope_check
      CHECK (read_scope IN ('self', 'subtree', 'list', 'org'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zv_tenant_users_scope_list_check'
  ) THEN
    -- A `list` reach with no list is not "everything" and not "nothing" by
    -- accident — it is a misconfiguration, and it is refused rather than
    -- silently resolving to one or the other.
    ALTER TABLE zv_tenant_users
      ADD CONSTRAINT zv_tenant_users_scope_list_check
      CHECK (
        (read_scope = 'list' AND scope_list IS NOT NULL AND cardinality(scope_list) > 0)
        OR (read_scope <> 'list' AND scope_list IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN zv_tenant_users.read_scope IS
  'How far this assignment can READ: self | subtree | list | org. Writing has no reach — see zveltio_tenant_write_ok.';
COMMENT ON COLUMN zv_tenant_users.valid_to IS
  'NULL = open-ended. Revocation is a date, so it needs no retelling elsewhere.';

CREATE INDEX IF NOT EXISTS idx_zv_tenant_users_user_valid
  ON zv_tenant_users(user_id, valid_from, valid_to);

-- ── 3. Moving a file between units is a fact, and facts are kept ───

CREATE TABLE IF NOT EXISTS zv_tenant_transfers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name  TEXT NOT NULL,
  record_id   UUID NOT NULL,
  from_tenant UUID NOT NULL REFERENCES zv_tenants(id),
  to_tenant   UUID NOT NULL REFERENCES zv_tenants(id),
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  moved_by    TEXT,
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_zv_tenant_transfers_record
  ON zv_tenant_transfers(table_name, record_id, moved_at DESC);

COMMENT ON TABLE zv_tenant_transfers IS
  'Journal of records moved between units. Not full temporal ownership — that '
  'would need columns on all 48 tenant tables — but it answers "who held this '
  'file in March", and it does not stand in the way of the fuller version.';

-- ── 4. The predicates ──────────────────────────────────────────────
--
-- Shaped as `tenant_id = ANY (<stable set function>)` rather than as a boolean
-- function of the row. The set functions are STABLE and take no argument, so
-- they are evaluated once per query rather than once per row, and the shape
-- reads as what it is: membership in the visible set.
--
-- A NOTE ON PERFORMANCE, CORRECTED TWICE. Read the whole thing before quoting
-- any of it, because the first two versions of this comment were both wrong.
--
-- v1 claimed this shape makes the plan indexable, on measurements taken with a
-- plain `WHERE`, which is not what a policy is.
-- v2 "corrected" that to say NO policy shape can use an index — that the
-- planner has no selectivity estimate for a security qual and therefore always
-- scans — with a table of five shapes all reading 500 000 rows.
--
-- v2 does not reproduce. Re-measured 2026-08-27 under `FORCE ROW LEVEL
-- SECURITY`, as the product runs it (transaction, `SET LOCAL ROLE zveltio_rls`,
-- transaction-local GUC), 500 000 rows of which 2 500 belong to the unit:
--
--   as a POLICY, boolean function of the row     Bitmap Index Scan, Index Cond   2 500 rows
--   as a POLICY, = ANY (set function)  ← this    Index Scan, Index Cond          2 500 rows
--
-- Both index. The deciding variable is not the predicate shape at all — it is
-- whether `tenant_id` is indexed. Drop the index and every shape seq-scans;
-- that is what v2 must have been measuring, comparing setups rather than
-- shapes. The same methodological error it accused v1 of.
--
-- What IS real, measured the same day, median of 5 on the same rows:
--
--                                                selective        full
--                                              2 500/500 000   500 000/500 000
--   no RLS at all                                     —            123 ms
--   boolean function of the row                     9.7 ms         204 ms
--   tenant_id = (SELECT scalar())                   9.0 ms         129 ms
--   = ANY (set function)   ← this shape             8.8 ms         410 ms
--   IN (SELECT unnest(set function))               25.7 ms         158 ms
--
-- So this shape is the FASTEST on a selective read and the SLOWEST on a full
-- one — 3.3x the no-RLS baseline. The full-scan column is the single-tenant
-- self-hosted install, where the unit owns every row and a full scan is the
-- correct plan. `= ANY (array)` gives the planner no way to estimate how much
-- of the table matches, so it takes the index and then reads all of it.
--
-- The scalar form avoids that because `eqsel` can use column statistics for a
-- Param, so it seq-scans when the tenant owns everything and index-scans when
-- it owns a slice. The hierarchy needs a set, so it cannot simply adopt it.
-- `IN (SELECT unnest(...))` gets the full-scan case back to 158 ms but loses
-- the index on the selective one — the two regimes want opposite plans.
--
-- Not resolved here, deliberately, because it is a trade-off and not a bug.
-- What IS fixed already is the part that was free: the predicate functions were
-- PARALLEL UNSAFE, which barred parallel plans everywhere. See
-- `003_rls_parallel_safe.sql` on master — 415 ms to 204 ms, no semantic change.
-- The numbers in the table above are all with that marker already applied.

-- Every function below is marked PARALLEL SAFE, and that is load-bearing rather
-- than decorative. A function created without the marker defaults to PARALLEL
-- UNSAFE, and the planner tests parallel safety on the parse tree BEFORE it
-- inlines SQL functions — so an unmarked function in a policy qual bars parallel
-- plans on every table that policy protects, even though it is inlined away and
-- never called. That cost 415 ms against 204 ms on a 500 000-row scan; see
-- `003_rls_parallel_safe.sql`.
--
-- The trap this migration would otherwise spring: `CREATE OR REPLACE FUNCTION`
-- RESETS attributes that are not restated. Two of the definitions below replace
-- `zveltio_tenant_scope_ok`, which 003 had just marked safe — so without the
-- marker here, this migration would silently undo that fix for the whole schema.
-- A test asserts the invariant generically (no function any RLS policy depends
-- on may be PARALLEL UNSAFE) rather than naming these, so the next function to
-- join a policy is covered too.

CREATE OR REPLACE FUNCTION zveltio_visible_tenants()
RETURNS uuid[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')::uuid[]
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      ARRAY[]::uuid[]
    ELSE
      ARRAY['00000000-0000-0000-0000-000000000001'::uuid]
  END
$$;

-- Three tables carry `tenant_id` as TEXT rather than uuid, two of them with a
-- policy. A single overload cannot serve both: `uuid = ANY(text[])` has no
-- operator, and casting the column would be the thing that loses the index.
CREATE OR REPLACE FUNCTION zveltio_visible_tenants_text()
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      ARRAY[]::text[]
    ELSE
      ARRAY['00000000-0000-0000-0000-000000000001']
  END
$$;

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

COMMENT ON FUNCTION zveltio_visible_tenants() IS
  'The units the current transaction may READ, as an array so a policy can be '
  'written as an indexable `tenant_id = ANY(...)`. Falls back to the 029 '
  'current_tenant equality and the 047 fail-closed opt-in when the middleware '
  'published no set — which is every background worker and every single-tenant '
  'install, and is why this migration is invisible to them.';

-- WRITE: the own node, and nothing else, whoever you are. Byte-for-byte the
-- predicate `zveltio_tenant_scope_ok` carried until this migration, which is
-- why splitting the two apart changes no write anywhere.
--
-- Left as a boolean function of the row on purpose: WITH CHECK is evaluated per
-- written row and is never used to choose an index, so the shape that matters
-- for reading buys nothing here, and a one-element comparison reads plainly.

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'
  END
$$;

-- The named boolean predicates stay, redefined over the sets above.
--
-- Not for the engine's own policies — those are rewritten below into the
-- indexable form — but because 57 extension migrations spell
-- `zveltio_tenant_scope_ok(tenant_id)` into the policies they create, and those
-- files are not all in this repository. An extension installed tomorrow gets a
-- correct, if unindexed, policy immediately, and the boot reconciler moves it
-- onto the fast shape. Deleting these would turn "slower until next boot" into
-- "migration fails on install".
--
-- Replaced in place with CREATE OR REPLACE rather than given a defaulted second
-- parameter: a one-argument function beside a two-argument one with
-- `DEFAULT false` makes every existing single-argument call ambiguous, and
-- Postgres answers `function zveltio_tenant_scope_ok(uuid) is not unique` on
-- all 315 policies at query time. Verified, not assumed. Dropping the old
-- signature is not available either — a policy takes a hard dependency on the
-- function it calls, and the drop is refused while any policy stands.

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT row_tenant = ANY (zveltio_visible_tenants())
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT row_tenant = ANY (zveltio_visible_tenants_text())
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

COMMENT ON FUNCTION zveltio_tenant_scope_ok(uuid) IS
  'Compatibility spelling of `tenant_id = ANY(zveltio_visible_tenants())`, for '
  'extension migrations that name it. Correct but not indexable — the boot '
  'reconciler rewrites policies onto the ANY form. See migration 003.';
COMMENT ON FUNCTION zveltio_tenant_write_ok(uuid) IS
  'Row WRITE permission: the own node only. Data belong to the subordinate; a '
  'level above reads and approves, it does not correct in another''s place.';

-- ── 5. Walking the tree — called once per request, never per row ───

CREATE OR REPLACE FUNCTION zveltio_tenant_subtree(root uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE walk(id, depth) AS (
    SELECT t.id, 0 FROM zv_tenants t WHERE t.id = root
    UNION ALL
    SELECT c.id, w.depth + 1
      FROM zv_tenants c JOIN walk w ON c.parent_id = w.id
     WHERE w.depth < 64
  )
  SELECT id FROM walk
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

COMMENT ON FUNCTION zveltio_tenant_subtree(uuid) IS
  'The unit and everything under it. Depth-capped at 64 as a second line behind '
  'the cycle trigger — a recursive walk over a cycle does not fail, it hangs.';

-- ── 6. The five tables from the coverage classification ────────────
--
-- Chosen because every existing access already carries a tenant filter and runs
-- inside the request transaction, so a policy is defence in depth with no
-- behaviour to break. The eleven others that also lack a policy are left alone
-- on purpose, each with a written reason — most of them because their only
-- reader is a background worker that runs on the pool with no GUC, where a
-- policy would not protect anything, it would silently switch the feature off.
--
-- zv_checklist_scoring_schemes is not defence in depth. A cross-tenant read
-- through it is demonstrated in the classification document.

DO $$
DECLARE
  t text;
  def text := 'COALESCE(NULLIF(current_setting(''zveltio.current_tenant'', true), '''')::uuid, '
              || '''00000000-0000-0000-0000-000000000001''::uuid)';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'zv_checklist_scoring_schemes',
    'zv_checklist_scheme_weights',
    'zv_checklist_scores',
    'zv_record_comments',
    'zv_saved_queries'
  ] LOOP
    -- Extension tables: absent unless that extension is installed.
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;

    -- A NULL tenant_id is invisible to everyone under this predicate, not
    -- visible to everyone. Pre-tenant rows belong to the default tenant, which
    -- is what migration 007 already decided for the engine's own tables.
    EXECUTE format('UPDATE %I SET tenant_id = %s WHERE tenant_id IS NULL', t, def);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %s', t, def);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id)', 'idx_' || t || '_tenant_id', t);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO zveltio_rls', t);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO public '
      || 'USING (tenant_id = ANY (zveltio_visible_tenants())) '
      || 'WITH CHECK (zveltio_tenant_write_ok(tenant_id))',
      'tenant_isolation_' || t, t);
  END LOOP;
END $$;

-- ── 7. Recreating every tenant policy, and counting what was touched ──
--
-- Two changes at once, because both need the policy dropped and recreated and
-- doing it twice would mean two full rewrites:
--
--   * the write half moves to `zveltio_tenant_write_ok`, so that widening what
--     a parent may READ did not widen what it may WRITE;
--   * the read half moves to `tenant_id = ANY (zveltio_visible_tenants())`, the
--     shape Postgres can answer from the index (see §4).
--
-- Which column and which overload are read from the catalogue rather than
-- assumed: three tables carry `tenant_id` as TEXT, two of them with a policy,
-- and handing them the uuid[] set would fail with "operator does not exist".
--
-- The count is not a hardcoded 315. That number is what a full extension
-- install happens to have today; an engine-only base has four, and every
-- operator has their own. The invariant that means something is that the number
-- rewritten equals the number found, and that none is left behind on the old
-- write predicate. Precedent for insisting: `ensureRlsEnforcementRole` once
-- left the zveltio_rls role holding 11 tables out of 378, and nothing said a
-- word.

DO $$
DECLARE
  r           record;
  n_before    int;
  n_rewritten int := 0;
  n_after     int;
  n_stale     int;
  read_expr   text;
BEGIN
  SELECT count(*) INTO n_before
    FROM pg_policies
   WHERE schemaname = 'public'
     AND qual LIKE '%zveltio_tenant_scope_ok%';

  FOR r IN
    SELECT p.tablename,
           p.policyname,
           a.atttypid = 'uuid'::regtype AS is_uuid
      FROM pg_policies p
      JOIN pg_class c
        ON c.relname = p.tablename
       AND c.relnamespace = 'public'::regnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
     WHERE p.schemaname = 'public'
       AND p.qual LIKE '%zveltio_tenant_scope_ok%'
  LOOP
    read_expr := CASE
      WHEN r.is_uuid THEN 'tenant_id = ANY (zveltio_visible_tenants())'
      ELSE 'tenant_id = ANY (zveltio_visible_tenants_text())'
    END;
    EXECUTE format('DROP POLICY %I ON %I', r.policyname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO public USING (%s) WITH CHECK (%s)',
      r.policyname,
      r.tablename,
      read_expr,
      'zveltio_tenant_write_ok(tenant_id)'
    );
    n_rewritten := n_rewritten + 1;
  END LOOP;

  -- Anything left calling the old name is a policy on a table with no
  -- `tenant_id` column at all, which cannot happen — and if it somehow does,
  -- it must be looked at rather than skipped.
  SELECT count(*) INTO n_stale
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (qual LIKE '%zveltio_tenant_scope_ok%' OR with_check LIKE '%zveltio_tenant_scope_ok%');

  SELECT count(*) INTO n_after
    FROM pg_policies
   WHERE schemaname = 'public'
     AND qual LIKE '%zveltio_visible_tenants%'
     AND with_check LIKE '%zveltio_tenant_write_ok%';

  IF n_rewritten <> n_before THEN
    RAISE EXCEPTION
      'tenant policy rewrite touched % of % policies — refusing to leave the rest on the old predicate',
      n_rewritten, n_before;
  END IF;

  IF n_stale <> 0 THEN
    RAISE EXCEPTION
      '% tenant policies still name the old combined predicate', n_stale;
  END IF;

  IF n_after < n_rewritten THEN
    RAISE EXCEPTION
      'only % of % rewritten policies carry both new predicates', n_after, n_rewritten;
  END IF;

  RAISE NOTICE '[003] % tenant policies split into read/write predicates', n_rewritten;
END $$;

-- ── 8. Which collections are inherited downward ────────────────────
--
-- Opt-in, and the flag lives on the collection, not on the row: it is compiled
-- into that collection's policy as a literal. Nothing is marked here — national
-- nomenclatures are configuration, not schema, and the engine's own tables are
-- not among them.

ALTER TABLE zvd_collections
  ADD COLUMN IF NOT EXISTS inherit_down BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN zvd_collections.inherit_down IS
  'Rows written at an ancestor unit are readable from below. Off by default: '
  'head-office payroll does not become county-visible merely by sitting higher. '
  'Upward visibility is NOT a per-collection flag — it is governed by read_scope '
  'on the assignment and by Casbin on the resource.';

-- DOWN

DROP FUNCTION IF EXISTS zveltio_ancestor_tenants_text();
DROP FUNCTION IF EXISTS zveltio_ancestor_tenants();
DROP FUNCTION IF EXISTS zveltio_visible_tenants_text();
DROP FUNCTION IF EXISTS zveltio_visible_tenants();
DROP FUNCTION IF EXISTS zveltio_tenant_ancestors(uuid);
DROP FUNCTION IF EXISTS zveltio_tenant_subtree(uuid);
DROP FUNCTION IF EXISTS zveltio_tenant_scope_ok(uuid, boolean);
DROP FUNCTION IF EXISTS zveltio_tenant_scope_ok(text, boolean);
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS inherit_down;
DROP TABLE IF EXISTS zv_tenant_transfers;
ALTER TABLE zv_tenant_users
  DROP COLUMN IF EXISTS read_scope,
  DROP COLUMN IF EXISTS scope_list,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS valid_to;
DROP TRIGGER IF EXISTS zv_tenants_no_cycle ON zv_tenants;
DROP FUNCTION IF EXISTS zveltio_tenant_no_cycle();
ALTER TABLE zv_tenants
  DROP COLUMN IF EXISTS parent_id,
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS merged_into;

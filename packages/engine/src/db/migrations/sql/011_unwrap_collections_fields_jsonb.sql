-- 011_unwrap_collections_fields_jsonb.sql
--
-- The fifth site of the family 009 and 010 belong to, and the one they missed.
--
-- 010 repaired the four columns found by asking a populated database which
-- `jsonb` columns held JSON *text*. `zvd_collections.fields` was not among them
-- for a reason that says something about the method: the instance that was
-- queried had no collections, so the column had no rows to be wrong in. Reading
-- the code finds it immediately — seven writers across four files, every one of
-- them `JSON.stringify(...)` bound to a `jsonb` column:
--
--     lib/data/ddl-manager.ts   registerMetadata (INSERT + ON CONFLICT), the
--                               field-count update, updateCollection
--     lib/introspection.ts      the INSERT and the UPDATE of an introspected table
--     routes/collections.ts     the add-field update
--     routes/relations.ts       add and remove of a relation field
--
-- All seven now go through `toJsonb` (`lib/jsonb.ts`). This repairs what they
-- already wrote.
--
-- ── Why it matters here more than in 010 ────────────────────────
--
-- `fields` is ARRAY-valued. As a jsonb string, `jsonb_array_elements(fields)`
-- raises rather than returning nothing — "cannot extract elements from a
-- scalar" — so the failure is not a quiet empty result but an error, for anyone
-- who writes the natural SQL. The engine ships one such query already
-- (`zv_encrypted_fields`, in 001), and it survives only because it was written
-- against the legacy `zv_collections` and is guarded by an existence check.
--
-- What kept this invisible is the same compensation 010 describes: the reader in
-- `ddl-manager.ts` carries `typeof row.fields === 'string' ? JSON.parse(row.fields)
-- : (row.fields ?? [])`. That line is left in place deliberately — an install
-- upgrading from a version before this migration has rows in the old shape until
-- it runs, and an extension may hold its own reader.
--
-- ── Shape ───────────────────────────────────────────────────────
--
-- Same guard as 009 and 010, and load-bearing for the same reason:
-- `(col #>> '{}')::jsonb` on a jsonb string that is not JSON raises, and a raise
-- aborts the migration. `fields` is always a JSON array when it is wrong, so the
-- `left(...) IN ('{', '[')` test admits exactly the rows that need unwrapping.
--
-- `WHERE jsonb_typeof(fields) = 'string'` makes it re-runnable: rows already in
-- the right shape do not match. Batched at 5 000 for consistency with 010, though
-- `zvd_collections` holds one row per collection and will never approach it.

DO $$
DECLARE
  moved BIGINT;
  total BIGINT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'zvd_collections'
  ) THEN
    RETURN;
  END IF;

  LOOP
    WITH batch AS (
      SELECT id FROM zvd_collections
       WHERE fields IS NOT NULL
         AND jsonb_typeof(fields) = 'string'
         AND left(fields #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zvd_collections t
       SET fields = (t.fields #>> '{}')::jsonb
      FROM batch
     WHERE t.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE '011: unwrapped % double-encoded zvd_collections.fields value(s)', total;
  END IF;
END $$;

-- DOWN
-- Deliberately empty. Re-wrapping the column would restore a defect, and every
-- reader in the tree accepts the corrected shape — the compensating parse in
-- `ddl-manager.ts` handles the old one, not the reverse.

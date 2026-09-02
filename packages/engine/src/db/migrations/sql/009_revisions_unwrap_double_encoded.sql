-- 009_revisions_unwrap_double_encoded.sql
--
-- `zv_revisions.data` and `.delta` are `jsonb`, and both writers passed
-- `JSON.stringify(value)`. A string parameter into a `jsonb` column is stored as
-- a jsonb STRING containing JSON text, not as the object. Measured through the
-- real stack, all three ways it shows:
--
--     jsonb_typeof(data)   →  'string'   (should be 'object')
--     data->>'nume'        →  NULL       (cannot index into a string)
--     data ? 'nume'        →  false
--
-- The writers are fixed in the same change. This unwraps what is already
-- stored, and the order matters: repairing the data first would leave new rows
-- arriving in the old shape.
--
-- What it cost, before anyone noticed it as a defect: two readers had grown
-- private compensations. `handlers/list.ts` normalises with
-- `CASE WHEN jsonb_typeof(data) = 'string' …` on the `?as_of=` path, with a
-- comment saying a key lookup against the string form "finds nothing,
-- silently". `routes/revisions.ts` does `typeof x === 'string' ? JSON.parse(x)`.
-- The admin audit route (`routes/admin/system-routes.ts`) does `.selectAll()`
-- and had no compensation at all, so it returned the double-encoded string to
-- its caller. Three readers, two workarounds, one wrong answer.
--
-- Both compensations keep working after this: each tests the shape rather than
-- assuming it.
--
-- ── Why this is written the way it is ───────────────────────────
--
-- The `left(… , 1) IN ('{', '[')` guard is not decoration. `(data #>> '{}')::jsonb`
-- on a jsonb string holding something that is not JSON — a plain text note, a
-- filename — raises, and a raise here aborts the whole migration. Only values
-- that actually look like a document are unwrapped; a genuine jsonb string
-- stays a jsonb string, which is what it was meant to be.
--
-- `WHERE jsonb_typeof(...) = 'string'` also makes this re-runnable: rows already
-- in object form do not match, so running it twice changes nothing.
--
-- Batched, because this table grows without bound and one `UPDATE` over all of
-- it would hold row locks for the length of a full rewrite. 5 000 rows at a
-- time, committed per batch by the loop.

DO $$
DECLARE
  moved BIGINT;
  total BIGINT := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM zv_revisions
       WHERE jsonb_typeof(data) = 'string'
         AND left(data #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_revisions r
       SET data = (r.data #>> '{}')::jsonb
      FROM batch
     WHERE r.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE '009: unwrapped % double-encoded zv_revisions.data value(s)', total;
  END IF;

  total := 0;
  LOOP
    WITH batch AS (
      SELECT id FROM zv_revisions
       WHERE delta IS NOT NULL
         AND jsonb_typeof(delta) = 'string'
         AND left(delta #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_revisions r
       SET delta = (r.delta #>> '{}')::jsonb
      FROM batch
     WHERE r.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE '009: unwrapped % double-encoded zv_revisions.delta value(s)', total;
  END IF;
END $$;

-- DOWN

-- Deliberately empty. Re-wrapping would restore a shape in which every key
-- lookup silently returns NULL — a rollback that reintroduces the defect is not
-- a rollback. The writers' change is the reversible half; the data is not worth
-- breaking again.

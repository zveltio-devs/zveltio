-- 108_location_native_point.sql
--
-- ADR 0019 tier 1: a `location` field is a built-in `point` (x = longitude,
-- y = latitude), no longer `GEOGRAPHY(POINT, 4326)`. A collection created
-- before this has a geography column, which the new `near`/`within` SQL and
-- the `(lng,lat)` I/O cannot read, so it is converted here. Only possible
-- where PostGIS is installed: without it no geography column can exist, and
-- the block does nothing. ALTER ... TYPE rebuilds the GiST index with the
-- point operator class.

DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM zvd_collections zc
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(zc.fields) = 'array' THEN zc.fields ELSE '[]'::jsonb END
      ) f
      JOIN information_schema.columns c
        ON c.table_schema = current_schema()
       AND c.table_name = 'zvd_' || zc.name
       AND c.column_name = f->>'name'
     WHERE f->>'type' = 'location'
       AND c.udt_name = 'geography'
  LOOP
    -- The column-masking view (zvv_<name>, migration 075) depends on every
    -- column; the boot reconcile builds it again. Any other dependent view
    -- refuses the ALTER: the column is then left as it was, with a warning,
    -- rather than the engine refusing to boot.
    BEGIN
      EXECUTE format('DROP VIEW IF EXISTS %I', 'zvv_' || substr(r.table_name, 5));
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE point USING point(ST_X(%I::geometry), ST_Y(%I::geometry))',
        r.table_name, r.column_name, r.column_name, r.column_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'location %.% not converted to point: %', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

-- DOWN
-- Not reversed: the engine no longer reads a geography `location` column.

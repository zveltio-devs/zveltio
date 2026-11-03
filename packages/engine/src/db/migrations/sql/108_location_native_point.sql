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
  gis TEXT;
BEGIN
  -- PostGIS's schema, which need not be on the search_path.
  SELECT n.nspname INTO gis
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'postgis';
  IF gis IS NULL THEN
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
    -- fails the migration, and the engine with it: a column left GEOGRAPHY
    -- would 500 on every write and every geo filter of this build.
    EXECUTE format('DROP VIEW IF EXISTS %I', 'zvv_' || substr(r.table_name, 5));
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE point USING point(%I.ST_X(%I::%I.geometry), %I.ST_Y(%I::%I.geometry))',
        r.table_name, r.column_name, gis, r.column_name, gis, gis, r.column_name, gis
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'location %.% could not be converted to point (ADR 0019): %. Drop what depends on it and run the migration again.',
        r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

-- DOWN
-- Not reversed: the engine no longer reads a geography `location` column.

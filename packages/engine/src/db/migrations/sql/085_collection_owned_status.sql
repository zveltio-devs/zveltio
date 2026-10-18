-- 085_collection_owned_status.sql
--
-- `status` stops being an engine system column (lib/data/ddl-manager.ts,
-- SYSTEM_COLUMNS). Every collection used to get
--
--     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived'))
--
-- which the data API stripped from every insert and update (`RESERVED`,
-- db/dynamic.ts) and nothing ever set, so no collection could have a writable
-- status. An extension's table with a business status of its own (CRM's
-- `zvd_transactions`) lost it on every write and in its adopted fields.
--
-- New collections get no `status` unless they declare one. An existing table
-- keeps its column, registered here as the field it now is, so it stays
-- readable, filterable and sortable and becomes writable: the engine's shape as
-- an `enum` of its three values (the CHECK stays), anything else as what
-- `introspectTable` maps its type to. A collection with no fields recorded is
-- left alone: a status-only field list would make the write pipeline drop every
-- other column. Its status stays writable (nothing strips it any more) but is
-- not filterable or sortable until the owner syncs fields from the database
-- (POST /api/collections/:name/sync-schema). A status of any other type is left for the
-- owner to register (adding a `status` field adopts the existing column).
--
-- Re-runnable: a collection whose fields already name `status` is skipped.

UPDATE zvd_collections c
   SET fields = c.fields || jsonb_build_array(
         CASE
           WHEN EXISTS (
             SELECT 1 FROM pg_constraint k
              WHERE k.conrelid = to_regclass(format('public.%I', 'zvd_' || c.name))
                AND k.contype = 'c'
                AND k.conkey = ARRAY[a_att.attnum]
                AND pg_get_constraintdef(k.oid) LIKE '%''active''%''draft''%''archived''%'
           )
           THEN jsonb_build_object(
             'name', 'status', 'type', 'enum', 'required', false, 'unique', false,
             'indexed', true, 'defaultValue', 'active',
             'options', jsonb_build_object('values', jsonb_build_array('active', 'draft', 'archived')))
           ELSE jsonb_build_object(
             'name', 'status',
             'type', CASE
               WHEN a.udt_name IN ('int2', 'int4', 'int8') THEN 'integer'
               WHEN a.udt_name = 'bool' THEN 'boolean'
               ELSE 'text'
             END,
             'required', false, 'unique', false, 'indexed', false)
         END),
       updated_at = NOW()
  FROM information_schema.columns a
  JOIN pg_attribute a_att
    ON a_att.attrelid = to_regclass(format('public.%I', a.table_name))
   AND a_att.attname = 'status'
 WHERE a.table_schema = 'public'
   AND a.table_name = 'zvd_' || c.name
   AND a.column_name = 'status'
   AND a.udt_name IN ('text', 'varchar', 'bpchar', 'int2', 'int4', 'int8', 'bool')
   AND jsonb_typeof(c.fields) = 'array'
   AND jsonb_array_length(c.fields) > 0
   AND NOT c.fields @> '[{"name": "status"}]';

-- DOWN
--
-- Metadata only. A collection created after this migration has no `status`
-- column, and an engine binary older than it assumes every table has one, so
-- rolling the binary back past 085 is not supported for such collections.

UPDATE zvd_collections
   SET fields = (SELECT coalesce(jsonb_agg(f), '[]'::jsonb)
                   FROM jsonb_array_elements(fields) f
                  WHERE f->>'name' <> 'status')
 WHERE jsonb_typeof(fields) = 'array'
   AND fields @> '[{"name": "status"}]';

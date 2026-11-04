-- 111_adopt_validation_tables.sql
--
-- Validation rule administration is the engine's: `/api/validation` (tenant
-- admins) and the Studio page Developer → Validation Rules. The
-- `developer/validation` extension that held it was retired, and the engine
-- takes over its three tables, already read and written here — the evaluator
-- (lib/validation-engine.ts), schema apply and export, the rule writers, and
-- the triggers of 096/097:
--
--   zvd_validation_rule_groups  how a field's instance rules combine (AND/OR):
--                               instance-wide since 091, no tenant column
--   zvd_validation_test_cases   a rule's test inputs and last outcome: the
--                               tenant's (FORCE RLS)
--   zvd_validation_import_log   one row per bulk import: the tenant's (FORCE RLS)
--
-- The shape is the one the extension's 001–004 left. On an instance that had
-- it installed every statement here finds its object and changes nothing, rows
-- included; on any other they create the tables. The control-table revoke of
-- the request role's DML on the groups (tenant-manager.ts) already names them.
--
-- Its registry rows go too, as 110's did: the loader treats an enabled row
-- whose files are absent as a bundle to fetch, and would mount the retired 1.x
-- routes at /ext/developer/validation beside the engine's. Its rows in the
-- extension migration ledger go with them: their DOWN drops these tables,
-- which are no longer the extension's to drop.

CREATE TABLE IF NOT EXISTS zvd_validation_rule_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field_name TEXT NOT NULL,
  description TEXT,
  logic TEXT NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND','OR')),
  rule_ids UUID[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 091's conversion, verbatim: an extension version older than its 004, installed
-- after 091, put the tenant column back, and only that 004 took it away. Before
-- the unique index, which two firms' groups of one name would otherwise refuse,
-- failing the boot. A no-op on every other install.
DO $$
DECLARE
  pol text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.zvd_validation_rule_groups'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped) THEN
    FOR pol IN SELECT policyname FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'zvd_validation_rule_groups' LOOP
      EXECUTE format('DROP POLICY %I ON public.zvd_validation_rule_groups', pol);
    END LOOP;
    ALTER TABLE zvd_validation_rule_groups NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE zvd_validation_rule_groups DISABLE ROW LEVEL SECURITY;
    DELETE FROM zvd_validation_rule_groups g
     USING (SELECT id,
                   row_number() OVER (
                     PARTITION BY collection, name
                     ORDER BY CASE
                                WHEN tenant_id = '00000000-0000-0000-0000-000000000001'::uuid THEN 0
                                WHEN tenant_id IS NULL THEN 1
                                ELSE 2
                              END,
                              created_at, id) AS rank
              FROM zvd_validation_rule_groups) r
     WHERE g.id = r.id AND r.rank > 1;
    ALTER TABLE zvd_validation_rule_groups DROP COLUMN tenant_id;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS zvd_validation_rule_groups_collection_name
  ON zvd_validation_rule_groups (collection, name);

CREATE TABLE IF NOT EXISTS zvd_validation_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL, -- zv_validation_rules; 097's trigger removes a deleted rule's
  label TEXT NOT NULL,
  input_value TEXT NOT NULL,
  previous_value TEXT, -- a `transition` rule's stored value; NULL is a create
  expected_result BOOLEAN NOT NULL,
  last_run_result BOOLEAN,
  last_run_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id UUID DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_validation_test_cases_rule ON zvd_validation_test_cases (rule_id);
CREATE INDEX IF NOT EXISTS idx_zvd_validation_test_cases_tenant ON zvd_validation_test_cases (tenant_id);

CREATE TABLE IF NOT EXISTS zvd_validation_import_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  imported_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id UUID DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_zvd_validation_import_log_tenant ON zvd_validation_import_log (tenant_id);

ALTER TABLE zvd_validation_test_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_validation_test_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE zvd_validation_import_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_validation_import_log FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'zvd_validation_test_cases'
                  AND policyname = 'tenant_isolation_zvd_validation_test_cases') THEN
    CREATE POLICY tenant_isolation_zvd_validation_test_cases ON zvd_validation_test_cases
      USING (zveltio_tenant_scope_ok(tenant_id))
      WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'zvd_validation_import_log'
                  AND policyname = 'tenant_isolation_zvd_validation_import_log') THEN
    CREATE POLICY tenant_isolation_zvd_validation_import_log ON zvd_validation_import_log
      USING (zveltio_tenant_scope_ok(tenant_id))
      WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
  END IF;
END $$;

DELETE FROM zv_extension_registry WHERE name = 'developer/validation';
DELETE FROM zv_migrations WHERE name LIKE 'ext:developer/validation:%';

-- DOWN

-- Not reversed: the extension no longer exists to take the tables back, and
-- dropping them would lose every instance's groups and test cases.
SELECT 1;

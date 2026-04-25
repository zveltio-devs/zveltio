-- Column-level access control — restricts read/write on individual fields per role
CREATE TABLE IF NOT EXISTS zvd_column_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_name text NOT NULL,
  column_name     text NOT NULL, -- use '*' for all columns
  role            text NOT NULL, -- role name; '*' matches all roles
  can_read        boolean NOT NULL DEFAULT true,
  can_write       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_name, column_name, role)
);

CREATE INDEX IF NOT EXISTS idx_col_perms_collection ON zvd_column_permissions (collection_name);

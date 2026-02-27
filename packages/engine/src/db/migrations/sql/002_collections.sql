-- Migration 002: Collections metadata, relations, permissions (Casbin)

-- Collections registry — tracks all user-defined collections
CREATE TABLE IF NOT EXISTS zvd_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  icon TEXT DEFAULT 'Table',
  route_group TEXT DEFAULT 'private'
    CHECK (route_group IN ('public', 'partners', 'private', 'admin')),
  is_permissioned BOOLEAN DEFAULT true,
  sort INTEGER DEFAULT 99,
  singular_name TEXT,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relations between collections
CREATE TABLE IF NOT EXISTS zvd_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('m2o', 'o2m', 'm2m', 'm2a')),
  source_collection TEXT NOT NULL,
  source_field TEXT NOT NULL,
  target_collection TEXT NOT NULL,
  target_field TEXT,
  junction_table TEXT,
  foreign_key_constraint TEXT,
  on_delete TEXT DEFAULT 'SET NULL'
    CHECK (on_delete IN ('CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION')),
  on_update TEXT DEFAULT 'CASCADE'
    CHECK (on_update IN ('CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_collection, source_field)
);

CREATE INDEX IF NOT EXISTS idx_zvd_relations_source ON zvd_relations(source_collection);
CREATE INDEX IF NOT EXISTS idx_zvd_relations_target ON zvd_relations(target_collection);

-- Casbin permissions policies
CREATE TABLE IF NOT EXISTS zvd_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ptype TEXT NOT NULL,
  v0 TEXT,
  v1 TEXT,
  v2 TEXT,
  v3 TEXT,
  v4 TEXT,
  v5 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_permissions_ptype ON zvd_permissions(ptype);
CREATE INDEX IF NOT EXISTS idx_zvd_permissions_v0 ON zvd_permissions(v0);

-- DDL job queue (async schema changes)
CREATE TABLE IF NOT EXISTS zv_ddl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_ddl_jobs_status ON zv_ddl_jobs(status);

-- Default admin permissions
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'admin', '*', '*'),
  ('p', 'member', 'zvd_*', 'read'),
  ('g', 'admin', 'admin'),
  ('g', 'manager', 'manager'),
  ('g', 'member', 'member')
ON CONFLICT DO NOTHING;

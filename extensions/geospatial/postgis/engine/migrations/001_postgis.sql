-- Enable PostGIS (requires superuser or pg_extension_owner on Postgres 15+)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Geofence zones (admin-defined areas)
CREATE TABLE IF NOT EXISTS zv_geofences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  zone        GEOGRAPHY(POLYGON, 4326) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofences_zone ON zv_geofences USING gist(zone);

-- e-Transport RO: Road transport goods monitoring via ANAF
CREATE TABLE IF NOT EXISTS zv_etransport_declarations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uit                 TEXT,                         -- Unique Identification Transport (from ANAF)
  transport_date      DATE NOT NULL,
  vehicle_plate       TEXT NOT NULL,
  driver_name         TEXT NOT NULL,
  driver_cnp          TEXT,

  -- Origin
  departure_address   TEXT NOT NULL,
  departure_county    TEXT NOT NULL,
  departure_country   TEXT NOT NULL DEFAULT 'RO',

  -- Destination
  destination_address TEXT NOT NULL,
  destination_county  TEXT NOT NULL,
  destination_country TEXT NOT NULL DEFAULT 'RO',

  -- Goods (JSONB array: [{tariff_code, description, quantity, unit, weight_kg}])
  goods               JSONB NOT NULL DEFAULT '[]',
  total_weight_kg     NUMERIC(10,2) NOT NULL DEFAULT 0,

  purpose             TEXT NOT NULL DEFAULT 'commercial',  -- commercial | personal | return
  status              TEXT NOT NULL DEFAULT 'draft',       -- draft | declared | in_transit | completed | cancelled
  anaf_response       JSONB,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_etransport_status ON zv_etransport_declarations(status);
CREATE INDEX IF NOT EXISTS idx_etransport_date ON zv_etransport_declarations(transport_date DESC);
CREATE INDEX IF NOT EXISTS idx_etransport_plate ON zv_etransport_declarations(vehicle_plate);

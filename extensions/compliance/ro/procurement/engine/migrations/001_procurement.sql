-- Supplier registry
CREATE TABLE IF NOT EXISTS zv_ro_suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  cui          TEXT NOT NULL UNIQUE,
  reg_com      TEXT,
  address      TEXT,
  county       TEXT,
  iban         TEXT,
  bank         TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  category     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchase orders
CREATE TABLE IF NOT EXISTS zv_ro_purchase_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number       TEXT NOT NULL UNIQUE,
  date         DATE NOT NULL,
  supplier_id  UUID REFERENCES zv_ro_suppliers(id),
  supplier_name TEXT NOT NULL,  -- denormalized for history
  supplier_cui  TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT,
  items        JSONB NOT NULL DEFAULT '[]',  -- [{description, quantity, unit, unit_price, total}]
  subtotal     NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total        NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'RON',
  budget_line  TEXT,  -- budget allocation code
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft, approved, received, cancelled
  approved_by  UUID,
  approved_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ,
  notes        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Budget lines
CREATE TABLE IF NOT EXISTS zv_ro_budget_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  year        INTEGER NOT NULL,
  allocated   NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'RON',
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_status ON zv_ro_purchase_orders(status, date DESC);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON zv_ro_purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_cui ON zv_ro_suppliers(cui);

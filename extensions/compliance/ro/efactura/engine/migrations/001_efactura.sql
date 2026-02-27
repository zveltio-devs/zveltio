-- e-Factura invoices
CREATE TABLE IF NOT EXISTS zv_efactura_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT NOT NULL,
  invoice_date    DATE NOT NULL,
  due_date        DATE,

  -- Seller (emitent)
  seller_name     TEXT NOT NULL,
  seller_cui      TEXT NOT NULL,  -- CUI/CIF fiscal code
  seller_reg_com  TEXT,
  seller_address  TEXT,
  seller_iban     TEXT,
  seller_bank     TEXT,

  -- Buyer (beneficiar)
  buyer_name      TEXT NOT NULL,
  buyer_cui       TEXT,
  buyer_address   TEXT,

  -- Lines stored as JSONB array
  lines           JSONB NOT NULL DEFAULT '[]',
  -- [{description, quantity, unit, unit_price, vat_rate, vat_amount, line_total}]

  -- Totals
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'RON',

  -- e-Factura submission
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft, xml_generated, submitted, accepted, rejected
  xml_content     TEXT,         -- UBL 2.1 XML
  anaf_index      TEXT,         -- ANAF upload index
  anaf_response   JSONB,        -- ANAF API response

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_efactura_status ON zv_efactura_invoices(status);
CREATE INDEX IF NOT EXISTS idx_efactura_seller ON zv_efactura_invoices(seller_cui);
CREATE INDEX IF NOT EXISTS idx_efactura_date ON zv_efactura_invoices(invoice_date DESC);

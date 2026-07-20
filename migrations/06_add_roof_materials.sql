-- Supplier roofing material price catalog, imported from Roof_SupplierPrice.xlsx.
-- Used by the Estimate step's material picker so quotes pull real supplier
-- rates instead of the old hardcoded 5-item list.

CREATE TABLE IF NOT EXISTS roof_materials (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category     VARCHAR(80),   -- source sheet, e.g. "Dimond", "Metalcraft", "Kingspan"
    supplier     VARCHAR(80),
    type         VARCHAR(80),   -- e.g. "Corrugate", "Flashings", "Insulation"
    sku          VARCHAR(120),
    description  TEXT NOT NULL,
    gauge        VARCHAR(40),
    coating      VARCHAR(80),
    unit         VARCHAR(20),
    rate_lm      DECIMAL(12,4),
    rate_m2      DECIMAL(12,4),
    cover_width  DECIMAL(10,2),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roof_materials_description ON roof_materials USING gin (to_tsvector('simple', description));
CREATE INDEX IF NOT EXISTS idx_roof_materials_sku ON roof_materials(sku);
CREATE INDEX IF NOT EXISTS idx_roof_materials_supplier ON roof_materials(supplier);
CREATE INDEX IF NOT EXISTS idx_roof_materials_category ON roof_materials(category);

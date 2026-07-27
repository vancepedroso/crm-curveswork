-- Master/template supplier catalog, cloned into a brand-new organization's
-- own roof_materials rows at signup (see backend/lib/materialsTemplate.js,
-- called from the Stripe checkout webhook). Kept as a physically separate
-- table rather than an `organization_id IS NULL` sentinel inside
-- roof_materials itself — that table is on the hot path of every quote
-- (constant search/suppliers/types/by-type calls), and a NULL-sentinel
-- design means one missed/wrong filter anywhere would silently leak
-- template rows into a tenant's picker. A separate table makes "this is
-- never queried by a tenant-facing route" structurally true.
--
-- Seeded once from the current roof_materials contents — at the point this
-- runs, every existing row belongs to the single legacy organization
-- created in migration 18, so this is really "make a master copy of what
-- exists today" before any second organization ever needs its own catalog.

CREATE TABLE IF NOT EXISTS roof_materials_templates (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category     VARCHAR(80),
    supplier     VARCHAR(80),
    type         VARCHAR(80),
    sku          VARCHAR(120),
    description  TEXT NOT NULL,
    gauge        VARCHAR(40),
    coating      VARCHAR(80),
    unit         VARCHAR(20),
    rate_lm      DECIMAL(12,4),
    rate_m2      DECIMAL(12,4),
    cover_width  DECIMAL(10,2),
    product_group VARCHAR(20),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO roof_materials_templates
  (category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group)
SELECT category, supplier, type, sku, description, gauge, coating, unit, rate_lm, rate_m2, cover_width, product_group
FROM roof_materials
WHERE NOT EXISTS (SELECT 1 FROM roof_materials_templates);

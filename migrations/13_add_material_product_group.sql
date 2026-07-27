-- Classifies each roof_materials row into a broad product family so the
-- app can tell a roof sheet apart from a flashing apart from an accessory
-- (gutter, downpipe, fixing, sealant, etc.) — neither `type` nor `category`
-- reliably distinguishes these today (`type` mixes all of them together,
-- `category` is just the source spreadsheet/brand).

ALTER TABLE roof_materials ADD COLUMN IF NOT EXISTS product_group VARCHAR(20);

UPDATE roof_materials SET product_group = 'flashing' WHERE product_group IS NULL AND type IN (
  'Flashing','Flashings','Soft Edge Flashing','Ridging','Barge Roll','Edging',
  'Dektite','Penetration','Top Hat','SE','Flashing Tape'
);

UPDATE roof_materials SET product_group = 'roof_sheet' WHERE product_group IS NULL AND type IN (
  'Trapezoidal','V-Rib','Six Rib','Flat Sheet','Corrugate','Dimondek 300','Dimondek 400',
  'Dimondclad Rib 20/50','Veedek','Solar Rib','Durolite','Topspan','Steelspan','Hi Five',
  'Styline','LT7','Topglass','Polycarbonate Sheet','Translucent Sheet','TPO','BB900','General',
  'Skylight','Opening Skylights','Fixed Skylights','Fixed Flat Roof Skylights'
);

-- Everything else (gutters, downpipes, fixings, sealant, tape, insulation,
-- timber, mesh, vents, brackets, unrecognized/NULL types, ...) is an accessory.
UPDATE roof_materials SET product_group = 'accessory' WHERE product_group IS NULL;

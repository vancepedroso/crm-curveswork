-- Real supplier material names/descriptions (from the roof_materials catalog)
-- are far longer than the old hardcoded 5-item list ("Long Run Steel" etc.)
-- that material_label(60) was originally sized for.

ALTER TABLE estimates ALTER COLUMN material_label TYPE VARCHAR(255);

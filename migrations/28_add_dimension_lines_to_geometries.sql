-- Dimension Tool (PlanSwift-style click-two-points reference measurement)
-- reference lines — visual-only annotations, never used in area/pricing
-- calculations, so this is a plain JSONB array of {id, p1, p2} objects
-- alongside the existing sections/accessories columns.
ALTER TABLE project_geometries ADD COLUMN dimension_lines JSONB DEFAULT '[]';

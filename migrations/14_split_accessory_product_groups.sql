-- Splits the generic 'accessory' bucket from migration 13 (and pulls
-- penetration-boot items out of 'flashing') into dedicated product_group
-- values for gutter/downpipe/drain/penetration, so each Measure-step tool
-- (Gutter, Downpipe, Roof Drain, Penetration) can pop up a brand picker
-- scoped to just its own product family, matching the roof_sheet/flashing
-- pickers instead of showing every unrelated accessory mixed together.

UPDATE roof_materials SET product_group = 'gutter' WHERE type IN (
  'Gutter','Gutter Bracket','Gutter Joiner','Gutter Stop Ends',
  'Box Gutter 175','Box Gutter 300','Box Gutter 125',
  'Folded Box 125','Folded Box 175','Folded Box 280',
  'Spouting Quad 125','Spouting Deep Quad','Spouting HR150','Spouting Quad SI',
  'Rainhead'
);

UPDATE roof_materials SET product_group = 'downpipe' WHERE type IN (
  'Downpipe','Downpipe PVC','DP955','DR955','DP Bends','DP Bracket'
);

UPDATE roof_materials SET product_group = 'drain' WHERE type IN (
  'Sump'
);

-- Penetration boots/flashings (Dektite, top hats, generic "Penetration"/"SE"
-- rows) were previously lumped into 'flashing' by migration 13 — move them
-- into their own group so the Penetration tool's picker doesn't show generic
-- ridge/hip/valley flashing coil products instead of pipe/vent boots.
UPDATE roof_materials SET product_group = 'penetration' WHERE type IN (
  'Dektite','Penetration','SE','Top Hat'
);

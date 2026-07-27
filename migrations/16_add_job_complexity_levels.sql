-- Job Complexity multipliers (Low/Medium/High/Complex/Very Complex) were
-- hardcoded in the frontend (COMPLEXITY_LEVELS constant) with no way to
-- adjust them without a code change. Stored as a JSON array in the existing
-- global app_settings key/value table (same mechanism already used for the
-- currency preference) so they're editable from a Settings page instead.

INSERT INTO app_settings (key, value) VALUES (
  'job_complexity_levels',
  '[
    {"key":"low",          "label":"Low",          "factor":1.0,  "desc":"Simple gable/mono roof, easy access"},
    {"key":"medium",       "label":"Medium",       "factor":1.15, "desc":"Standard hip roof, normal access"},
    {"key":"high",         "label":"High",         "factor":1.3,  "desc":"Multiple planes, steep pitch or restricted access"},
    {"key":"complex",      "label":"Complex",      "factor":1.5,  "desc":"Heavy cutting, valleys/dormers, height/safety gear"},
    {"key":"very_complex", "label":"Very Complex", "factor":1.75, "desc":"Highly irregular roof, difficult access, specialist crew"}
  ]'
) ON CONFLICT (key) DO NOTHING;

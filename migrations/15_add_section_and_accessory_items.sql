-- Per-section roof sheet brand/rate, and per-item gutter run / downpipe /
-- drain / penetration brand/rate, mirroring how flashing_runs already
-- stores its per-subtype array. Without these, picking a brand for a
-- section or accessory in the Estimate step only lived in frontend state
-- and was silently lost on save/reload — there was nowhere to persist it.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS sections JSONB DEFAULT '[]';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS gutter_runs JSONB DEFAULT '[]';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS downpipe_items JSONB DEFAULT '[]';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS drain_items JSONB DEFAULT '[]';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS penetration_items JSONB DEFAULT '[]';

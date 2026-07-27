-- Per-subtype flashing runs (ridge cap, hip cap, valley, etc.), each with its
-- own traced length + supplier rate, replacing the single flat flashings
-- number that couldn't distinguish between named roof positions.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS flashing_runs JSONB DEFAULT '[]';

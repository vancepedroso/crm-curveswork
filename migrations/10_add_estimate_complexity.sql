-- Job complexity level (Low/Medium/High/Complex/Very Complex) applied as a
-- labour-cost multiplier in the Estimate step.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS complexity VARCHAR(20) DEFAULT 'medium';

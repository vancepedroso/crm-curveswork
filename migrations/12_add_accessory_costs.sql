-- Downpipe/drain/penetration counts and their costs, so accessories traced
-- on the roof photo can actually be priced instead of only ever showing as
-- an informational count with no line item in the quotation.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS downpipes INTEGER DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS drains INTEGER DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS penetrations INTEGER DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS downpipe_cost DECIMAL(10,2) DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS drain_cost DECIMAL(10,2) DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS penetration_cost DECIMAL(10,2) DEFAULT 0;

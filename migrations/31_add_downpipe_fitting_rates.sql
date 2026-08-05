-- Downpipe bend/elbow and spreader rates: previously hardcoded app
-- constants, now a real per-organization Settings value like every other
-- editable rate. Global default lives on company_profiles; the rate
-- actually applied to a given quote is frozen onto its own estimates row
-- at save time, same "a past quote shouldn't silently reprice itself
-- later" rationale as gst_rate/discount.
ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS downpipe_bend_rate NUMERIC DEFAULT 15;
ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS spreader_rate NUMERIC DEFAULT 45;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS downpipe_bend_rate NUMERIC DEFAULT 15;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS spreader_rate NUMERIC DEFAULT 45;

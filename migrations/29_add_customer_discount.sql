-- General Customer Discount: a promo-style discount applied to every quote's
-- subtotal before GST. Global default lives on company_profiles (edited in
-- Settings); the value actually applied to a given quote is frozen onto its
-- own estimates row at save time, same "a past quote shouldn't silently
-- reprice itself later" rationale as gst_rate (migration 26).

ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS discount_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) DEFAULT 'percent';
ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS discount_value DECIMAL(8,2) DEFAULT 0;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) DEFAULT 'percent';
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_value DECIMAL(8,2) DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_amt DECIMAL(10,2) DEFAULT 0;

-- Downpipe stock-cutting: the set of stock lengths (metres, comma-separated,
-- e.g. "1.8,2.4") a company buys downpipe in, used to work out how many
-- pieces a traced downpipe run needs and how much gets wasted. Editable in
-- Settings since suppliers vary.
ALTER TABLE company_profiles ADD COLUMN IF NOT EXISTS downpipe_stock_lengths TEXT DEFAULT '1.8,2.4';

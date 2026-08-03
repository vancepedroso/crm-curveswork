-- Currency (currencies table, 'currency' app_setting) and GST/VAT country
-- (tax_rates table, 'tax_country' app_setting) were two independent
-- settings, each with its own picker — nothing stopped an organization
-- from quoting in AUD while charging NZ's 15% GST. Merging them into one
-- table + one setting means they physically cannot disagree with each
-- other, instead of relying on sync logic that could still drift.
--
-- `currencies` and `tax_rates` are left in place, just unused going
-- forward — dropping them isn't necessary and would be needlessly
-- destructive for zero benefit.
CREATE TABLE business_regions (
    country_code    VARCHAR(2) PRIMARY KEY,
    country_name    VARCHAR(100) NOT NULL,
    currency_code   VARCHAR(3)  NOT NULL,
    currency_symbol VARCHAR(10) NOT NULL,
    currency_name   VARCHAR(100) NOT NULL,
    locale          VARCHAR(10) DEFAULT 'en-US',
    gst_rate        DECIMAL(6,4) NOT NULL
);

INSERT INTO business_regions (country_code, country_name, currency_code, currency_symbol, currency_name, locale, gst_rate) VALUES
    ('NZ', 'New Zealand',    'NZD', '$',  'New Zealand Dollar',   'en-NZ', 0.15),
    ('AU', 'Australia',      'AUD', '$',  'Australian Dollar',    'en-AU', 0.10),
    ('GB', 'United Kingdom', 'GBP', '£',  'British Pound',        'en-GB', 0.20),
    ('US', 'United States',  'USD', '$',  'US Dollar',            'en-US', 0.00),
    ('CA', 'Canada',         'CAD', '$',  'Canadian Dollar',      'en-CA', 0.05),
    ('PH', 'Philippines',    'PHP', '₱',  'Philippine Peso',      'en-PH', 0.12),
    ('SG', 'Singapore',      'SGD', '$',  'Singapore Dollar',     'en-SG', 0.09),
    ('IE', 'Ireland',        'EUR', '€',  'Euro',                 'en-IE', 0.23),
    ('ZA', 'South Africa',   'ZAR', 'R',  'South African Rand',   'en-ZA', 0.15),
    ('IN', 'India',          'INR', '₹',  'Indian Rupee',         'en-IN', 0.18),
    ('JP', 'Japan',          'JPY', '¥',  'Japanese Yen',         'ja-JP', 0.10),
    ('HK', 'Hong Kong',      'HKD', '$',  'Hong Kong Dollar',     'en-HK', 0.00),
    ('TH', 'Thailand',       'THB', '฿',  'Thai Baht',            'th-TH', 0.07),
    ('MY', 'Malaysia',       'MYR', 'RM', 'Malaysian Ringgit',    'en-MY', 0.06);

-- One key replaces both 'currency' and 'tax_country' — backfilled from
-- each org's existing tax_country (already a valid country_code here), so
-- an org that had already picked a GST country keeps that as its starting
-- business_region. An org that had ONLY changed its currency (not its tax
-- country) has that manual currency choice superseded by this merge — an
-- acceptable one-time tradeoff for what's currently a same-day feature.
INSERT INTO app_settings (organization_id, key, value)
SELECT organization_id, 'business_region', value
FROM app_settings
WHERE key = 'tax_country'
ON CONFLICT (organization_id, key) DO NOTHING;

-- Orgs with neither setting yet (shouldn't exist, but just in case) default to NZ.
INSERT INTO app_settings (organization_id, key, value)
SELECT id, 'business_region', 'NZ' FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

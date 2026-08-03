-- GST/VAT rate was previously a hardcoded 15% constant (App.jsx GST_RATE),
-- fixed regardless of which country an organization actually operates in.
-- tax_rates is global reference data — same shape/pattern as `currencies`
-- (every organization picks from the same shared list, not tenant-owned).
CREATE TABLE tax_rates (
    country_code VARCHAR(2) PRIMARY KEY,
    country_name VARCHAR(100) NOT NULL,
    rate         DECIMAL(6,4) NOT NULL  -- e.g. 0.1500 for 15%
);

INSERT INTO tax_rates (country_code, country_name, rate) VALUES
    ('NZ', 'New Zealand',    0.15),
    ('AU', 'Australia',      0.10),
    ('GB', 'United Kingdom', 0.20),
    ('US', 'United States',  0.00),
    ('CA', 'Canada',         0.05),
    ('PH', 'Philippines',    0.12),
    ('SG', 'Singapore',      0.09),
    ('IE', 'Ireland',        0.23),
    ('ZA', 'South Africa',   0.15),
    ('IN', 'India',          0.18);

-- Which country's rate each organization's quotes use — same per-org
-- key/value pattern already used for the 'currency' preference.
INSERT INTO app_settings (organization_id, key, value)
SELECT id, 'tax_country', 'NZ' FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

-- Historical estimates keep the rate that was actually applied at save
-- time, independent of whatever an organization's tax_country is set to
-- later — a saved quote shouldn't silently reprice itself.
ALTER TABLE estimates ADD COLUMN gst_rate DECIMAL(6,4) DEFAULT 0.15;

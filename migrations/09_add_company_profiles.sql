-- Per-user quotation branding (logo, signature/sign-off, accreditation badges)
-- and a place to store a snapshot image of the traced measurement canvas so
-- it can be embedded in generated quotes.

CREATE TABLE IF NOT EXISTS company_profiles (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_name      VARCHAR(120) DEFAULT 'DK Roofing',
    company_address   TEXT,
    company_phone     VARCHAR(40),
    company_email     VARCHAR(150),
    company_gst       VARCHAR(40),
    company_bank      VARCHAR(120),
    logo_url          TEXT,
    badges_url        TEXT,
    estimator_name    VARCHAR(120),
    estimator_title   VARCHAR(80),
    day_rate          DECIMAL(8,2) DEFAULT 850,
    margin            DECIMAL(5,1) DEFAULT 20,
    wastage           DECIMAL(5,1) DEFAULT 10,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_profiles_user ON company_profiles(user_id);

ALTER TABLE project_geometries ADD COLUMN IF NOT EXISTS snapshot_url TEXT;

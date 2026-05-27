-- database/schema.sql
-- Run: psql -U your_user -d your_db -f database/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────── CUSTOMERS ───────────────
CREATE TABLE customers (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(120) NOT NULL,
    email       VARCHAR(180),
    phone       VARCHAR(40),
    address     TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── PROJECTS ───────────────
CREATE TYPE project_status AS ENUM (
    'New Lead', 'Estimating', 'Quote Sent', 'Won', 'Lost'
);

CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    address     TEXT,
    status      project_status DEFAULT 'New Lead',
    area        DECIMAL(10,2) DEFAULT 0,
    roof_type   VARCHAR(60),
    notes       TEXT,
    quote_num   VARCHAR(20),
    quote_date  DATE,
    created_at  DATE DEFAULT CURRENT_DATE,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── ESTIMATES ───────────────
CREATE TABLE estimates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    area            DECIMAL(10,2) DEFAULT 0,
    pitch           DECIMAL(6,3) DEFAULT 1.15,
    waste           DECIMAL(5,1) DEFAULT 10,
    material_rate   DECIMAL(8,2) DEFAULT 55,
    material_label  VARCHAR(60) DEFAULT 'Long Run Steel',
    flashings       DECIMAL(8,2) DEFAULT 0,
    guttering       DECIMAL(8,2) DEFAULT 0,
    day_rate        DECIMAL(8,2) DEFAULT 850,
    days            DECIMAL(4,1) DEFAULT 2,
    margin          DECIMAL(5,1) DEFAULT 20,
    adj_area        DECIMAL(10,2) DEFAULT 0,
    mat_cost        DECIMAL(10,2) DEFAULT 0,
    flash_cost      DECIMAL(10,2) DEFAULT 0,
    gut_cost        DECIMAL(10,2) DEFAULT 0,
    lab_cost        DECIMAL(10,2) DEFAULT 0,
    margin_amt      DECIMAL(10,2) DEFAULT 0,
    sell_price      DECIMAL(10,2) DEFAULT 0,
    gst             DECIMAL(10,2) DEFAULT 0,
    total           DECIMAL(10,2) DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── GEOMETRY (Measurement Tool) ───────────────
CREATE TABLE project_geometries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sections            JSONB DEFAULT '[]',
    accessories         JSONB DEFAULT '{}',
    asbestos            BOOLEAN DEFAULT FALSE,
    scale_m_per_px      DECIMAL(12,8) DEFAULT 0.05,
    total_footprint_m2  DECIMAL(10,2) DEFAULT 0,
    total_surface_m2    DECIMAL(10,2) DEFAULT 0,
    total_flashing_m    DECIMAL(8,2) DEFAULT 0,
    total_gutter_m      DECIMAL(8,2) DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── INDEXES ───────────────
CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_projects_status   ON projects(status);
CREATE INDEX idx_estimates_project ON estimates(project_id);
CREATE INDEX idx_geometries_project ON project_geometries(project_id);

-- ─────────────── UPDATED_AT TRIGGER ───────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_estimates_updated BEFORE UPDATE ON estimates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_geometries_updated BEFORE UPDATE ON project_geometries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
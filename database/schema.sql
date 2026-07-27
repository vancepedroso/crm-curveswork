-- database/schema.sql
-- Run: psql -U your_user -d your_db -f database/schema.sql
--
-- Multi-tenant: every tenant-owned table below carries organization_id,
-- denormalized directly rather than only on top-level entities — several
-- tables (roof_materials, app_settings, roof_types) have no natural parent
-- to join through at all, and a column on every table is the precondition
-- for adding Postgres Row-Level Security later as defense-in-depth
-- (deferred, not implemented yet). organizations.id is a plain SERIAL
-- (matching users.id) even though the older tenant tables use UUID.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────── ORGANIZATIONS & USERS ───────────────
CREATE TABLE organizations (
    id                      SERIAL PRIMARY KEY,
    name                    VARCHAR(120) NOT NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'trialing', -- trialing/active/past_due/canceled
    stripe_customer_id      VARCHAR(120) UNIQUE,
    stripe_subscription_id  VARCHAR(120) UNIQUE,
    plan_key                VARCHAR(40),
    seat_limit              INTEGER NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
    id                 SERIAL PRIMARY KEY,
    name               VARCHAR(120) NOT NULL,
    email              VARCHAR(180) UNIQUE NOT NULL,
    password_hash      TEXT NOT NULL,
    is_active          BOOLEAN DEFAULT TRUE,
    currency           VARCHAR(10),
    preferred_currency VARCHAR(10),
    organization_id    INTEGER REFERENCES organizations(id),
    role               VARCHAR(20) NOT NULL DEFAULT 'member', -- owner/admin/member
    is_platform_admin  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Stripe webhook idempotency — Stripe can and does redeliver events.
CREATE TABLE stripe_event_log (
    event_id     VARCHAR(120) PRIMARY KEY,
    event_type   VARCHAR(80) NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── CUSTOMERS ───────────────
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(180),
    phone           VARCHAR(40),
    address         TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── JOBS ───────────────
CREATE TABLE jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    job_number      VARCHAR(60) NOT NULL,
    notes           TEXT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE job_photos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    filename        VARCHAR(255) NOT NULL,
    url             TEXT NOT NULL,
    caption         VARCHAR(255),
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── PROJECTS ───────────────
CREATE TYPE project_status AS ENUM (
    'New Lead', 'Estimating', 'Quote Sent', 'Won', 'Lost'
);

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
    address         TEXT,
    status          project_status DEFAULT 'New Lead',
    area            DECIMAL(10,2) DEFAULT 0,
    roof_type       VARCHAR(60),
    notes           TEXT,
    quote_num       VARCHAR(20),
    quote_date      DATE,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      DATE DEFAULT CURRENT_DATE,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── ESTIMATES ───────────────
CREATE TABLE estimates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    area            DECIMAL(10,2) DEFAULT 0,
    pitch           DECIMAL(6,3) DEFAULT 1.15,
    waste           DECIMAL(5,1) DEFAULT 10,
    material_rate   DECIMAL(8,2) DEFAULT 55,
    material_label  VARCHAR(255) DEFAULT 'Long Run Steel',
    flashings       DECIMAL(8,2) DEFAULT 0,
    guttering       DECIMAL(8,2) DEFAULT 0,
    downpipes       INTEGER DEFAULT 0,
    drains          INTEGER DEFAULT 0,
    penetrations    INTEGER DEFAULT 0,
    day_rate        DECIMAL(8,2) DEFAULT 850,
    days            DECIMAL(4,1) DEFAULT 2,
    margin          DECIMAL(5,1) DEFAULT 20,
    complexity      VARCHAR(20) DEFAULT 'medium',
    flashing_runs   JSONB DEFAULT '[]',
    sections           JSONB DEFAULT '[]',
    gutter_runs        JSONB DEFAULT '[]',
    downpipe_items     JSONB DEFAULT '[]',
    drain_items        JSONB DEFAULT '[]',
    penetration_items  JSONB DEFAULT '[]',
    adj_area        DECIMAL(10,2) DEFAULT 0,
    mat_cost        DECIMAL(10,2) DEFAULT 0,
    flash_cost      DECIMAL(10,2) DEFAULT 0,
    gut_cost        DECIMAL(10,2) DEFAULT 0,
    downpipe_cost   DECIMAL(10,2) DEFAULT 0,
    drain_cost      DECIMAL(10,2) DEFAULT 0,
    penetration_cost DECIMAL(10,2) DEFAULT 0,
    lab_cost        DECIMAL(10,2) DEFAULT 0,
    margin_amt      DECIMAL(10,2) DEFAULT 0,
    sell_price      DECIMAL(10,2) DEFAULT 0,
    gst             DECIMAL(10,2) DEFAULT 0,
    total           DECIMAL(10,2) DEFAULT 0,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
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
    snapshot_url        TEXT,
    organization_id     INTEGER NOT NULL REFERENCES organizations(id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── PROJECT PHOTOS & QUOTE HISTORY ───────────────
CREATE TABLE project_photos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename        VARCHAR(255) NOT NULL,
    url             TEXT NOT NULL,
    caption         VARCHAR(255),
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE quotes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    quote_num       VARCHAR(20) NOT NULL,
    quote_date      DATE NOT NULL,
    total           DECIMAL(10,2) DEFAULT 0,
    snapshot        JSONB DEFAULT '{}',
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── COMPANY PROFILES (per-organization quotation branding) ───────────────
-- One profile per organization, shared by every user in it — not per-user.
CREATE TABLE company_profiles (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL, -- creator, informational only — not the tenancy key
    organization_id   INTEGER UNIQUE NOT NULL REFERENCES organizations(id),
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

-- ─────────────── SUPPLIER MATERIAL CATALOG (per-organization) ───────────────
-- Each organization has its own copy, cloned from roof_materials_templates
-- at signup (backend/lib/materialsTemplate.js) and independently editable
-- afterward (backend/scripts/importMaterials.js --org <id>).
CREATE TABLE roof_materials (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    category        VARCHAR(80),   -- source sheet/brand, e.g. "Dimond", "Metalcraft"
    supplier        VARCHAR(80),
    type            VARCHAR(80),   -- e.g. "Corrugate", "Flashings", "Insulation"
    sku             VARCHAR(120),
    description     TEXT NOT NULL,
    gauge           VARCHAR(40),
    coating         VARCHAR(80),
    unit            VARCHAR(20),
    rate_lm         DECIMAL(12,4),
    rate_m2         DECIMAL(12,4),
    cover_width     DECIMAL(10,2),
    product_group   VARCHAR(20),   -- roof_sheet / flashing / gutter / downpipe / drain / penetration / accessory
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Master/template catalog a brand-new organization's roof_materials rows
-- are cloned from at signup — never queried by any tenant-facing route.
CREATE TABLE roof_materials_templates (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category      VARCHAR(80),
    supplier      VARCHAR(80),
    type          VARCHAR(80),
    sku           VARCHAR(120),
    description   TEXT NOT NULL,
    gauge         VARCHAR(40),
    coating       VARCHAR(80),
    unit          VARCHAR(20),
    rate_lm       DECIMAL(12,4),
    rate_m2       DECIMAL(12,4),
    cover_width   DECIMAL(10,2),
    product_group VARCHAR(20),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────── ROOF TYPES (per-organization; not currently used by the frontend) ───────────────
CREATE TABLE roof_types (
    id              SERIAL PRIMARY KEY,
    label           VARCHAR(80) NOT NULL,
    rate_per_sqm    DECIMAL(10,2) DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id)
);

-- ─────────────── GLOBAL APP SETTINGS (currency preference, Job Complexity levels — per organization) ───────────────
CREATE TABLE app_settings (
    key             VARCHAR(50) NOT NULL,
    value           TEXT NOT NULL,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (organization_id, key)
);

-- Supported currencies — reference data, not tenant-owned; every
-- organization picks from the same list.
CREATE TABLE currencies (
    code    VARCHAR(3) PRIMARY KEY,
    symbol  VARCHAR(10) NOT NULL,
    name    VARCHAR(100) NOT NULL,
    locale  VARCHAR(10) DEFAULT 'en-US'
);

-- ─────────────── INDEXES ───────────────
CREATE INDEX idx_users_organization ON users(organization_id);
CREATE INDEX idx_customers_org ON customers(organization_id);
CREATE INDEX idx_jobs_org ON jobs(organization_id);
CREATE INDEX idx_job_photos_org ON job_photos(organization_id);
CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_estimates_org ON estimates(organization_id);
CREATE INDEX idx_project_geometries_org ON project_geometries(organization_id);
CREATE INDEX idx_project_photos_org ON project_photos(organization_id);
CREATE INDEX idx_quotes_org ON quotes(organization_id);
CREATE INDEX idx_roof_materials_org ON roof_materials(organization_id);
CREATE INDEX idx_app_settings_org ON app_settings(organization_id);
CREATE INDEX idx_roof_types_org ON roof_types(organization_id);

CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_projects_status   ON projects(status);
CREATE INDEX idx_estimates_project ON estimates(project_id);
CREATE INDEX idx_geometries_project ON project_geometries(project_id);
CREATE INDEX idx_jobs_customer ON jobs(customer_id);
CREATE INDEX idx_job_photos_job ON job_photos(job_id);
CREATE INDEX idx_projects_job ON projects(job_id);
CREATE INDEX idx_company_profiles_org ON company_profiles(organization_id);
CREATE INDEX idx_projects_is_deleted ON projects(is_deleted);
CREATE INDEX idx_roof_materials_description ON roof_materials USING gin (to_tsvector('simple', description));
CREATE INDEX idx_roof_materials_sku ON roof_materials(sku);
CREATE INDEX idx_roof_materials_supplier ON roof_materials(supplier);
CREATE INDEX idx_roof_materials_category ON roof_materials(category);

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
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_company_profiles_updated BEFORE UPDATE ON company_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Adds project photo storage and persisted quote history.

CREATE TABLE IF NOT EXISTS project_photos (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename    VARCHAR(255) NOT NULL,
    url         TEXT NOT NULL,
    caption     VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photos_project ON project_photos(project_id);

CREATE TABLE IF NOT EXISTS quotes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    quote_num   VARCHAR(20) NOT NULL,
    quote_date  DATE NOT NULL,
    total       DECIMAL(10,2) DEFAULT 0,
    snapshot    JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_project ON quotes(project_id);

-- Adds organization_id to every tenant-owned table (nullable for now —
-- NOT NULL is deferred to a later migration, once the backfill below is
-- verified) and assigns every existing row to one "Legacy Workspace"
-- organization, so nothing that already exists in this database breaks
-- once routes start requiring organization_id on every query.
--
-- Denormalized onto every table directly (not just top-level entities
-- scoped via a JOIN back to a parent) because several of these tables
-- (roof_materials, app_settings, roof_types) have no natural parent to
-- join through at all, and it's the precondition for adding Postgres
-- Row-Level Security later as defense-in-depth.
--
-- SAFETY: take a full pg_dump of this database before running this against
-- any environment with real data you care about. Runs inside a single
-- transaction so a failure partway through rolls back cleanly.

BEGIN;

ALTER TABLE customers          ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE jobs               ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE job_photos         ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE projects           ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE estimates          ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE project_geometries ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE project_photos     ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE quotes             ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE roof_materials     ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE company_profiles   ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE app_settings       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE roof_types         ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_customers_org          ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org               ON jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_job_photos_org         ON job_photos(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_org           ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_estimates_org          ON estimates(organization_id);
CREATE INDEX IF NOT EXISTS idx_project_geometries_org ON project_geometries(organization_id);
CREATE INDEX IF NOT EXISTS idx_project_photos_org     ON project_photos(organization_id);
CREATE INDEX IF NOT EXISTS idx_quotes_org             ON quotes(organization_id);
CREATE INDEX IF NOT EXISTS idx_roof_materials_org     ON roof_materials(organization_id);
CREATE INDEX IF NOT EXISTS idx_app_settings_org        ON app_settings(organization_id);
CREATE INDEX IF NOT EXISTS idx_roof_types_org         ON roof_types(organization_id);

INSERT INTO organizations (name, status, plan_key, seat_limit)
SELECT 'Legacy Workspace', 'active', 'legacy', 999
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE plan_key = 'legacy');

DO $$
DECLARE legacy_org_id INTEGER;
BEGIN
  SELECT id INTO legacy_org_id FROM organizations WHERE plan_key = 'legacy' LIMIT 1;

  UPDATE users             SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE customers         SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE jobs              SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE job_photos        SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE projects          SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE estimates         SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE project_geometries SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE project_photos    SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE quotes            SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE roof_materials    SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE company_profiles  SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE app_settings      SET organization_id = legacy_org_id WHERE organization_id IS NULL;
  UPDATE roof_types        SET organization_id = legacy_org_id WHERE organization_id IS NULL;
END $$;

COMMIT;

-- NOT NULL constraints are intentionally deferred to a later migration,
-- run only after verifying every row above actually got backfilled.

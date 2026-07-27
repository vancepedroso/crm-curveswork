-- app_settings' primary key was just (key) — globally unique, so two
-- organizations could never both have a 'currency' or
-- 'job_complexity_levels' row. Now that every row is tagged with
-- organization_id (migration 18, already backfilled), the key only needs to
-- be unique WITHIN an organization.

BEGIN;

ALTER TABLE app_settings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (organization_id, key);

COMMIT;

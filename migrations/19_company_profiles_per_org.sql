-- company_profiles moves from one-per-USER to one-per-ORGANIZATION — every
-- user in an org shares the same branding/day-rate defaults, matching how
-- a real company's quotes should look regardless of which of its
-- estimators generates one. organization_id already exists and is backfilled
-- (migration 18); this just re-keys the table on it instead of user_id.

BEGIN;

ALTER TABLE company_profiles DROP CONSTRAINT IF EXISTS company_profiles_user_id_key;
ALTER TABLE company_profiles DROP CONSTRAINT IF EXISTS company_profiles_user_id_not_null;
ALTER TABLE company_profiles ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE company_profiles ALTER COLUMN organization_id SET NOT NULL;

-- If more than one user had already created their own profile before this
-- migration (only possible in the legacy single-tenant data), keep just the
-- oldest one per organization and drop the rest, so the UNIQUE(organization_id)
-- constraint below can actually be added.
DELETE FROM company_profiles a USING company_profiles b
WHERE a.organization_id = b.organization_id AND a.id > b.id;

ALTER TABLE company_profiles ADD CONSTRAINT company_profiles_organization_id_key UNIQUE (organization_id);

COMMIT;

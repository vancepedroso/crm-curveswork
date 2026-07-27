-- Migration 17 defaulted every user's role to 'member' with nobody ever
-- promoted to 'owner'/'admin' — so nobody in the pre-existing Legacy
-- Workspace could manage users or billing at all. Promotes every user
-- already in that org to 'owner' (safe for a pre-launch single workspace;
-- once real customer orgs exist via Stripe signup, their first user is
-- already created as 'owner' by the checkout webhook — see
-- backend/routes/stripeWebhook.js).
UPDATE users SET role = 'owner'
WHERE organization_id = (SELECT id FROM organizations WHERE plan_key = 'legacy')
  AND role = 'member';

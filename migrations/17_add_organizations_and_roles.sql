-- Multi-tenant foundation: every user belongs to an organization, which
-- owns a subscription (Stripe-backed, wired up in a later migration/route
-- pass) and a seat limit. Also brings `users` under version control for the
-- first time — it was previously created ad hoc directly against the live
-- database and never appeared in any tracked migration or schema.sql.

CREATE TABLE IF NOT EXISTS organizations (
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

CREATE TABLE IF NOT EXISTS users (
    id                 SERIAL PRIMARY KEY,
    name               VARCHAR(120) NOT NULL,
    email              VARCHAR(180) UNIQUE NOT NULL,
    password_hash      TEXT NOT NULL,
    is_active          BOOLEAN DEFAULT TRUE,
    currency           VARCHAR(10),
    preferred_currency VARCHAR(10),
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'member'; -- owner/admin/member
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);

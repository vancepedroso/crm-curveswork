-- Placeholder payment-method storage used only while STRIPE_SECRET_KEY
-- isn't configured — lets the Billing & Plan UI be built/demoed end-to-end
-- before real Stripe keys exist. Deliberately stores brand/last4/expiry
-- only: never a full card number or CVV, which this app must never persist
-- regardless of whether Stripe is wired up yet (see backend/routes/billing.js).
-- Once real Stripe keys are set, billing.js switches to the real
-- Stripe PaymentMethod APIs and this table simply stops being written to.
CREATE TABLE dummy_payment_methods (
    id               SERIAL PRIMARY KEY,
    organization_id  INTEGER NOT NULL REFERENCES organizations(id),
    brand            VARCHAR(30) NOT NULL,
    last4            VARCHAR(4)  NOT NULL,
    exp_month        INTEGER NOT NULL,
    exp_year         INTEGER NOT NULL,
    is_default       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dummy_payment_methods_org ON dummy_payment_methods(organization_id);

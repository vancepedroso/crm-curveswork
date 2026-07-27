-- Idempotency bookkeeping for Stripe webhook events — Stripe can and does
-- redeliver the same event, and not every event type has an obvious
-- natural key to dedupe on (checkout.session.completed can check
-- stripe_subscription_id, but this covers every event type uniformly).
CREATE TABLE IF NOT EXISTS stripe_event_log (
    event_id    VARCHAR(120) PRIMARY KEY,
    event_type  VARCHAR(80) NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

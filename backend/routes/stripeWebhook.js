// Stripe webhook — mounted in server.js with express.raw() BEFORE
// express.json(), since signature verification needs the untouched raw
// request body. Every event is verified via stripe.webhooks.constructEvent
// and logged into stripe_event_log for idempotency before being acted on,
// since Stripe can and does redeliver events.
const { Router } = require("express");
const Stripe = require("stripe");
const pool   = require("../db");
const { PLANS } = require("../config/plans");
const { cloneMaterialsTemplateForOrg } = require("../lib/materialsTemplate");

const router = Router();
// See billing.js for why this falls back to a placeholder instead of "" —
// an empty string throws at import time and would take down the whole
// backend, not just this route.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_not_configured");
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// True if this is the first time we're seeing this event id.
async function markEventProcessed(client, eventId, eventType) {
  const { rows } = await client.query(
    "INSERT INTO stripe_event_log (event_id, event_type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
    [eventId, eventType]
  );
  return rows.length > 0;
}

async function handleCheckoutCompleted(client, session) {
  const { companyName, email, passwordHash, planKey } = session.metadata || {};
  if (!companyName || !email || !passwordHash || !planKey) {
    console.error("[stripe webhook] checkout.session.completed missing expected metadata", session.id);
    return;
  }
  const plan = PLANS[planKey];
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

  // Idempotency beyond the event-log check above — a redelivered event for
  // a subscription that already produced an org should be a no-op, not a
  // second org.
  const { rows: existingOrg } = await client.query(
    "SELECT id FROM organizations WHERE stripe_subscription_id = $1", [subscriptionId]
  );
  if (existingOrg.length) return;

  const { rows: [org] } = await client.query(
    `INSERT INTO organizations (name, status, stripe_customer_id, stripe_subscription_id, plan_key, seat_limit)
     VALUES ($1, 'active', $2, $3, $4, $5) RETURNING id`,
    [companyName, customerId, subscriptionId, planKey, plan?.seatLimit || 1]
  );

  await client.query(
    `INSERT INTO users (name, email, password_hash, organization_id, role)
     VALUES ($1, $2, $3, $4, 'owner')`,
    [companyName, email, passwordHash, org.id]
  );

  await cloneMaterialsTemplateForOrg(client, org.id);
}

async function handleSubscriptionUpdated(client, subscription) {
  const planKey = Object.entries(PLANS).find(([, p]) => p.stripePriceId === subscription.items?.data?.[0]?.price?.id)?.[0];
  const seatLimit = planKey ? PLANS[planKey].seatLimit : undefined;
  await client.query(
    `UPDATE organizations SET
       status = $1,
       plan_key = COALESCE($2, plan_key),
       seat_limit = COALESCE($3, seat_limit),
       updated_at = NOW()
     WHERE stripe_subscription_id = $4`,
    [subscription.status === "active" ? "active" : subscription.status, planKey || null, seatLimit || null, subscription.id]
  );
  // Seat-downgrade handling: intentionally no extra logic here. If the new
  // seat_limit drops below the org's current active user count, nobody is
  // force-removed or force-logged-out — POST /api/users (invite) and the
  // reactivate check in PATCH /api/users/:id/status already compare against
  // organizations.seat_limit on every attempt, so the same block applies to
  // new invites/reactivations regardless of whether the cause was growth or
  // a downgrade.
}

async function handleSubscriptionDeleted(client, subscription) {
  await client.query(
    "UPDATE organizations SET status = 'canceled', updated_at = NOW() WHERE stripe_subscription_id = $1",
    [subscription.id]
  );
}

async function handlePaymentFailed(client, invoice) {
  const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;
  await client.query(
    "UPDATE organizations SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1",
    [subscriptionId]
  );
}

router.post("/", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe webhook] signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const isNew = await markEventProcessed(client, event.id, event.type);
    if (!isNew) {
      await client.query("COMMIT");
      return res.json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(client, event.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(client, event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(client, event.data.object);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(client, event.data.object);
        break;
      default:
        break; // unhandled event types are fine — just logged as processed above
    }

    await client.query("COMMIT");
    res.json({ received: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[stripe webhook] handler error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

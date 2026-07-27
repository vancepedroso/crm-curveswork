// Hardcoded plan config rather than a DB table — there are zero existing
// plans to migrate from, and hasFeature(org, key) is the boundary either
// way if this ever needs to move to a table later.
//
// stripePriceId values are placeholders — replace them with real Price IDs
// from your Stripe Dashboard (Product catalog) before going live. seatLimit
// is also duplicated onto organizations.seat_limit directly (not looked up
// from here at read time) so a webhook can set it straight from Stripe, and
// so a manually-comped org can have a custom seat count without needing a
// special plan entry.
const PLANS = {
  starter: {
    label: "Starter",
    stripePriceId: process.env.STRIPE_PRICE_STARTER || "price_REPLACE_ME_STARTER",
    seatLimit: 3,
    features: {},
  },
  pro: {
    label: "Pro",
    stripePriceId: process.env.STRIPE_PRICE_PRO || "price_REPLACE_ME_PRO",
    seatLimit: 10,
    features: {},
  },
};

// `features` bags are intentionally empty placeholders — this is plumbing
// only; which specific features get gated per tier is a product decision
// for later, not guessed here.
function hasFeature(org, key) {
  return !!PLANS[org?.plan_key]?.features?.[key];
}

module.exports = { PLANS, hasFeature };

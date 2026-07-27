// Public signup (start a paid trial) + billing management for existing
// orgs. The actual organization/user are NOT created here in the real
// Stripe path — only on confirmed payment, via the checkout.session.completed
// webhook (backend/routes/stripeWebhook.js) — an abandoned Checkout should
// never leave a half-working login behind.
const { Router } = require("express");
const bcrypt = require("bcrypt");
const Stripe = require("stripe");
const pool   = require("../db");
const { PLANS } = require("../config/plans");
const { requireAuth } = require("../middleware/auth");
const { cloneMaterialsTemplateForOrg } = require("../lib/materialsTemplate");
const { signUser } = require("./auth");

const router = Router();
// A dummy placeholder key avoids the SDK throwing at import time when
// STRIPE_SECRET_KEY isn't set yet — that would take down the whole backend
// (every other route too), not just billing.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_not_configured");

// True once real Stripe keys are in the environment. Until then, every
// route below that would otherwise call the Stripe API falls back to a
// local "dummy" path instead — signup creates the org directly, and
// payment methods are stored in dummy_payment_methods (brand/last4/expiry
// only, never a full card number or CVV). Flip this on by setting
// STRIPE_SECRET_KEY in .env; every route here switches over on its own.
const STRIPE_CONFIGURED = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== "sk_test_not_configured";

// Fresh DB lookup rather than trusting the JWT's cached `role` claim — a
// role change must take effect immediately, not only once the caller's
// token happens to expire. Same pattern as isManager() in routes/users.js.
// Owner AND admin can manage billing/payment methods — only owner is still
// required for anything that would actually change money (there's nothing
// like that here yet; this file only manages cards on file).
async function isBillingManager(req) {
  const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [req.user.id]);
  return rows[0]?.role === "owner" || rows[0]?.role === "admin";
}

// Every org needs a Stripe Customer before it can attach a card. Orgs
// created through Checkout already have one (set by the webhook); orgs
// backfilled from the pre-SaaS "Legacy Workspace" migration don't, since
// no real Stripe subscription ever created one for them — so this creates
// it lazily on the first "Add Payment Method" instead of requiring a
// separate one-off migration/backfill step.
async function getOrCreateCustomerId(req) {
  const { rows } = await pool.query(
    "SELECT stripe_customer_id, name FROM organizations WHERE id = $1", [req.user.organizationId]
  );
  const org = rows[0];
  if (org.stripe_customer_id) return org.stripe_customer_id;

  const customer = await stripe.customers.create({ name: org.name });
  await pool.query(
    "UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2", [customer.id, req.user.organizationId]
  );
  return customer.id;
}

// A payment method id is opaque and guessable-ish (sequential-looking),
// so /default and /delete below always re-check it actually belongs to
// the caller's own Stripe customer before touching it — otherwise org A
// could set/detach org B's card just by knowing its id.
async function assertOwnedPaymentMethod(customerId, paymentMethodId) {
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (pm.customer !== customerId) throw Object.assign(new Error("Not found"), { status: 404 });
  return pm;
}

// Dummy payment methods are given ids like "dummy_14" so /default and
// /delete below can tell at a glance which storage (Stripe vs the local
// placeholder table) a given id belongs to, without needing a global
// STRIPE_CONFIGURED check at every call site.
const dummyId    = row => `dummy_${row.id}`;
const isDummyId  = id  => typeof id === "string" && id.startsWith("dummy_");
const rawDummyId = id  => parseInt(id.slice("dummy_".length), 10);

// POST /api/billing/checkout-session — public, pre-account
// Body: { companyName, email, password, planKey }
router.post("/checkout-session", async (req, res) => {
  try {
    const { companyName, email, password, planKey } = req.body;
    if (!companyName || !email || !password || !planKey) {
      return res.status(400).json({ error: "companyName, email, password and planKey are required" });
    }
    const plan = PLANS[planKey];
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${planKey}` });
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) return res.status(400).json({ error: "Email already in use" });

    // Hash now, not in the webhook — Stripe stores metadata on its own
    // servers and shows it in the dashboard, so the plaintext password must
    // never travel through it, only the bcrypt hash.
    const passwordHash = await bcrypt.hash(password, 10);

    // No real Stripe keys yet — create the org + owner directly instead of
    // starting a Checkout session that would just fail with an API-key
    // error. This branch stops being used the moment STRIPE_SECRET_KEY is
    // set; nothing else needs to change.
    if (!STRIPE_CONFIGURED) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [org] } = await client.query(
          `INSERT INTO organizations (name, status, plan_key, seat_limit)
           VALUES ($1, 'trialing', $2, $3) RETURNING id`,
          [companyName, planKey, plan.seatLimit]
        );
        const { rows: [userRow] } = await client.query(
          `INSERT INTO users (name, email, password_hash, organization_id, role)
           VALUES ($1, $2, $3, $4, 'owner') RETURNING *`,
          [companyName, email, passwordHash, org.id]
        );
        await cloneMaterialsTemplateForOrg(client, org.id);
        await client.query("COMMIT");
        return res.json({ bypassed: true, ...signUser(userRow) });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      customer_email: email,
      success_url: `${process.env.APP_URL || "http://localhost:5173"}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || "http://localhost:5173"}/signup`,
      metadata: {
        companyName,
        email,
        passwordHash,
        planKey,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing] checkout-session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/portal-session — requireAuth, owner/admin. Redirects
// the caller into the Stripe Customer Portal for self-service upgrade/
// downgrade/cancel. Has no dummy-mode equivalent — there's nothing
// meaningful to fake for a full billing-history/plan-change page — so this
// just returns a clear "not configured yet" message until real keys exist.
router.get("/portal-session", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can manage billing" });
    }
    if (!STRIPE_CONFIGURED) {
      return res.status(400).json({ error: "Stripe isn't configured yet — add STRIPE_SECRET_KEY to the backend's .env to enable the billing portal." });
    }
    const { rows } = await pool.query(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1", [req.user.organizationId]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: "No billing account on file" });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.APP_URL || "http://localhost:5173",
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("[billing] portal-session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/payment-methods — requireAuth, owner/admin. Mirrors the
// cards on file — from Stripe once configured, from the local
// dummy_payment_methods placeholder table until then.
router.get("/payment-methods", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can view billing" });
    }

    if (!STRIPE_CONFIGURED) {
      const { rows } = await pool.query(
        "SELECT * FROM dummy_payment_methods WHERE organization_id = $1 ORDER BY created_at ASC",
        [req.user.organizationId]
      );
      const defaultRow = rows.find(r => r.is_default);
      return res.json({
        defaultPaymentMethodId: defaultRow ? dummyId(defaultRow) : null,
        paymentMethods: rows.map(r => ({
          id: dummyId(r), brand: r.brand, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year,
        })),
      });
    }

    const { rows } = await pool.query(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1", [req.user.organizationId]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.json({ paymentMethods: [], defaultPaymentMethodId: null });

    const [customer, methods] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.paymentMethods.list({ customer: customerId, type: "card" }),
    ]);
    const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method || null;

    res.json({
      defaultPaymentMethodId,
      paymentMethods: methods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand || "card",
        last4: pm.card?.last4 || "????",
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
      })),
    });
  } catch (err) {
    console.error("[billing] payment-methods:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/publishable-key — requireAuth. The Stripe *publishable*
// key is safe to hand to the frontend (it's meant to be public), unlike
// STRIPE_SECRET_KEY which never leaves this server. Empty until configured
// — the frontend treats that as "use the dummy card form" instead of an error.
router.get("/publishable-key", requireAuth, (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "" });
});

// POST /api/billing/setup-intent — requireAuth, owner/admin. Creates a
// real Stripe SetupIntent once configured; until then, tells the frontend
// to fall back to the dummy card form (no clientSecret to hand out).
router.post("/setup-intent", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can manage billing" });
    }
    if (!STRIPE_CONFIGURED) return res.json({ dummy: true });

    const customerId = await getOrCreateCustomerId(req);
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
    });
    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error("[billing] setup-intent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/payment-methods/dummy — requireAuth, owner/admin.
// Dummy-mode only equivalent of confirming a SetupIntent: the frontend
// never sends us the full card number or CVV, only what's safe to keep —
// brand (detected client-side from the number's leading digits), last4,
// and expiry. Blocked once real Stripe keys are set, so real and fake
// cards never mix in the same list.
router.post("/payment-methods/dummy", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can manage billing" });
    }
    if (STRIPE_CONFIGURED) return res.status(400).json({ error: "Stripe is configured — use the real card form." });

    const { brand, last4, expMonth, expYear } = req.body;
    if (!last4 || !/^\d{4}$/.test(last4)) return res.status(400).json({ error: "Invalid card" });
    const month = parseInt(expMonth, 10), year = parseInt(expYear, 10);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      return res.status(400).json({ error: "Invalid expiry date" });
    }

    const { rows } = await pool.query(
      `INSERT INTO dummy_payment_methods (organization_id, brand, last4, exp_month, exp_year)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.organizationId, brand || "card", last4, month, year]
    );
    res.status(201).json({ id: dummyId(rows[0]) });
  } catch (err) {
    console.error("[billing] payment-methods/dummy:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/payment-methods/:id/default — requireAuth, owner/admin.
router.post("/payment-methods/:id/default", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can manage billing" });
    }

    if (isDummyId(req.params.id)) {
      const rowId = rawDummyId(req.params.id);
      const { rows: owned } = await pool.query(
        "SELECT id FROM dummy_payment_methods WHERE id = $1 AND organization_id = $2", [rowId, req.user.organizationId]
      );
      if (!owned.length) return res.status(404).json({ error: "Not found" });
      await pool.query("UPDATE dummy_payment_methods SET is_default = (id = $1) WHERE organization_id = $2", [rowId, req.user.organizationId]);
      return res.json({ ok: true });
    }

    const customerId = await getOrCreateCustomerId(req);
    await assertOwnedPaymentMethod(customerId, req.params.id);
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: req.params.id },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[billing] set-default-payment-method:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/billing/payment-methods/:id — requireAuth, owner/admin.
router.delete("/payment-methods/:id", requireAuth, async (req, res) => {
  try {
    if (!(await isBillingManager(req))) {
      return res.status(403).json({ error: "Only the organization owner or admin can manage billing" });
    }

    if (isDummyId(req.params.id)) {
      const rowId = rawDummyId(req.params.id);
      const { rowCount } = await pool.query(
        "DELETE FROM dummy_payment_methods WHERE id = $1 AND organization_id = $2", [rowId, req.user.organizationId]
      );
      if (!rowCount) return res.status(404).json({ error: "Not found" });
      return res.json({ ok: true });
    }

    const customerId = await getOrCreateCustomerId(req);
    await assertOwnedPaymentMethod(customerId, req.params.id);
    await stripe.paymentMethods.detach(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[billing] delete-payment-method:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;

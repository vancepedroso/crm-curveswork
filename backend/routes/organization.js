// GET /api/organization — the caller's own org's plan/seat/status info.
// Never exposes stripe_customer_id/stripe_subscription_id to the frontend.
const { Router } = require("express");
const pool   = require("../db");
const router = Router();

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, status, plan_key, seat_limit FROM organizations WHERE id = $1",
      [req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Organization not found" });

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM users WHERE organization_id = $1 AND is_active = true",
      [req.user.organizationId]
    );

    // Read fresh from the DB rather than trusting the JWT's cached `role`
    // claim — same reasoning as isManager()/requirePlatformAdmin: a role
    // change (e.g. the legacy-user owner promotion) must take effect
    // immediately, not only once the caller's token happens to expire.
    const { rows: meRows } = await pool.query(
      "SELECT role FROM users WHERE id = $1", [req.user.id]
    );

    const org = rows[0];
    res.json({
      id: org.id,
      name: org.name,
      status: org.status,
      planKey: org.plan_key,
      seatLimit: org.seat_limit,
      activeUserCount: parseInt(countRows[0].count, 10),
      myRole: meRows[0]?.role || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

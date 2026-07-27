const { Router } = require("express");
const pool   = require("../db");
const bcrypt = require("bcrypt");
const jwt    = require("jsonwebtoken");
const { JWT_SECRET, CURRENT_TOKEN_VERSION } = require("../middleware/auth");
const router = Router();

function signUser(row) {
  const user = {
    id: row.id, name: row.name, email: row.email,
    organizationId: row.organization_id, role: row.role, isPlatformAdmin: row.is_platform_admin,
  };
  const token = jwt.sign({ ...user, v: CURRENT_TOKEN_VERSION }, JWT_SECRET, { expiresIn: "7d" });
  return { token, user };
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1", [email]
    );
    if (!rows.length)
      return res.status(401).json({ error: "Invalid email or password" });

    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match)
      return res.status(401).json({ error: "Invalid email or password" });

    // Block disabled accounts
    if (rows[0].is_active === false)
      return res.status(403).json({ error: "This account has been disabled. Contact your administrator." });

    res.json(signUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register is retired — account creation now only happens
// through Stripe Checkout signup (backend/routes/billing.js), which creates
// the organization and its first "owner" user together. A bare register
// endpoint with no organization to attach to would leave a user stranded
// with no tenant, so it's removed rather than patched.

module.exports = router;
module.exports.signUser = signUser;
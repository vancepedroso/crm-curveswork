const { Router } = require("express");
const pool = require("../db");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "changeme_use_env_in_prod";

const router = Router();

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorised" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── GET /api/settings/currency ────────────────────────────────────────
// Get current currency setting
router.get("/currency", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      ["currency"]
    );
    const currentCurrency = rows[0]?.value || "NZD";
    res.json({ currency: currentCurrency });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch currency setting" });
  }
});

// ── GET /api/settings/currencies ──────────────────────────────────────
// Get list of all supported currencies
router.get("/currencies", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, symbol, name, locale FROM currencies ORDER BY code ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch currencies" });
  }
});

// ── PUT /api/settings/currency ────────────────────────────────────────
// Update currency setting (admin only)
router.put("/currency", requireAuth, async (req, res) => {
  try {
    const { currency } = req.body;
    if (!currency)
      return res.status(400).json({ error: "Currency code is required" });

    // Validate currency exists
    const { rows: currencyCheck } = await pool.query(
      `SELECT code FROM currencies WHERE code = $1`,
      [currency.toUpperCase()]
    );
    if (!currencyCheck[0])
      return res.status(400).json({ error: "Unsupported currency code" });

    // Update setting
    await pool.query(
      `UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = $2`,
      [currency.toUpperCase(), "currency"]
    );

    res.json({ currency: currency.toUpperCase(), message: "Currency updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update currency" });
  }
});

module.exports = router;

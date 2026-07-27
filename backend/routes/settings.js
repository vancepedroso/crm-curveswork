/**
 * routes/settings.js
 *
 * Mount point (in server.js): app.use("/api/settings", settingsRouter)
 *
 * Endpoints:
 *   GET  /api/settings/currencies       → full list from currencies table (global, not tenant data)
 *   GET  /api/settings/user-currency    → current saved preference for the caller's organization
 *   PUT  /api/settings/user-currency    → save preference { code: "NZD" } for the caller's organization
 *
 * app_settings is keyed by (organization_id, key) — the currency
 * preference used to be a single global row; it's now one per org so two
 * organizations don't silently overwrite each other's setting.
 */

const express = require("express");
const router  = express.Router();
const pool    = require("../db");

// ── GET /api/settings/currencies ─────────────────────────────────────────────
// The list of supported currencies is reference data, not tenant-owned —
// every organization picks from the same list.
router.get("/currencies", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT code, symbol, name, locale FROM currencies ORDER BY code"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[settings] GET /currencies:", err.message);
    res.status(500).json({ error: "Failed to fetch currencies" });
  }
});

// ── GET /api/settings/user-currency ──────────────────────────────────────────
// Returns { code: "NZD" } for the caller's organization
router.get("/user-currency", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE organization_id = $1 AND key = 'currency'",
      [req.user.organizationId]
    );

    if (result.rows.length === 0) {
      // Self-heal: seed the default row for this org if somehow missing
      await pool.query(
        "INSERT INTO app_settings (organization_id, key, value) VALUES ($1, 'currency', 'NZD') ON CONFLICT (organization_id, key) DO NOTHING",
        [req.user.organizationId]
      );
      return res.json({ code: "NZD" });
    }

    res.json({ code: result.rows[0].value });
  } catch (err) {
    console.error("[settings] GET /user-currency:", err.message);
    res.status(500).json({ error: "Failed to fetch currency preference" });
  }
});

// ── PUT /api/settings/user-currency ──────────────────────────────────────────
// Body: { code: "PHP" } — saved against the caller's organization
router.put("/user-currency", async (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "currency code is required" });
  }

  const trimmed = code.trim().toUpperCase();

  try {
    // Validate the code exists in the currencies table
    const check = await pool.query(
      "SELECT code FROM currencies WHERE code = $1",
      [trimmed]
    );

    if (check.rows.length === 0) {
      return res.status(400).json({ error: `Unknown currency code: ${trimmed}` });
    }

    // Upsert into app_settings, scoped to this organization
    await pool.query(
      `INSERT INTO app_settings (organization_id, key, value, updated_at)
       VALUES ($1, 'currency', $2, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE
         SET value      = EXCLUDED.value,
             updated_at = NOW()`,
      [req.user.organizationId, trimmed]
    );

    res.json({ code: trimmed });
  } catch (err) {
    console.error("[settings] PUT /user-currency:", err.message);
    res.status(500).json({ error: "Failed to save currency preference" });
  }
});

module.exports = router;

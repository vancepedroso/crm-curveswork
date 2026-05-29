/**
 * routes/settings.js
 *
 * Mount point (in server.js): app.use("/api/settings", settingsRouter)
 *
 * Endpoints:
 *   GET  /api/settings/currencies       → full list from currencies table
 *   GET  /api/settings/user-currency    → current saved preference
 *   PUT  /api/settings/user-currency    → save preference { code: "NZD" }
 */

const express = require("express");
const router  = express.Router();
const pool    = require("../db");

// ── GET /api/settings/currencies ─────────────────────────────────────────────
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
// Returns { code: "NZD" }
router.get("/user-currency", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'currency'"
    );

    if (result.rows.length === 0) {
      // Self-heal: seed the default row if somehow missing
      await pool.query(
        "INSERT INTO app_settings (key, value) VALUES ('currency', 'NZD') ON CONFLICT (key) DO NOTHING"
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
// Body: { code: "PHP" }
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

    // Upsert into app_settings
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('currency', $1, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value      = EXCLUDED.value,
             updated_at = NOW()`,
      [trimmed]
    );

    res.json({ code: trimmed });
  } catch (err) {
    console.error("[settings] PUT /user-currency:", err.message);
    res.status(500).json({ error: "Failed to save currency preference" });
  }
});

module.exports = router;
/**
 * routes/settings.js
 *
 * Mount point (in server.js): app.use("/api/settings", settingsRouter)
 *
 * Endpoints:
 *   GET  /api/settings/business-regions       → full list from business_regions table (global, not tenant data)
 *   GET  /api/settings/org-business-region    → current saved region for the caller's organization
 *   PUT  /api/settings/org-business-region    → save { countryCode: "AU" } for the caller's organization
 *
 * A "business region" carries currency AND GST/VAT rate together (one
 * organization-wide setting, not two that need to be kept in sync — an
 * org can't end up quoting in one currency while charging another
 * country's tax rate). app_settings is keyed by (organization_id, key),
 * one row per org so two organizations don't overwrite each other's setting.
 */

const express = require("express");
const router  = express.Router();
const pool    = require("../db");

// ── GET /api/settings/business-regions ───────────────────────────────────────
// The list of supported regions is reference data, not tenant-owned —
// every organization picks from the same list.
router.get("/business-regions", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT country_code, country_name, currency_code, currency_symbol, currency_name, locale, gst_rate FROM business_regions ORDER BY country_name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[settings] GET /business-regions:", err.message);
    res.status(500).json({ error: "Failed to fetch business regions" });
  }
});

// ── GET /api/settings/org-business-region ────────────────────────────────────
// Returns { countryCode: "NZ" } for the caller's organization
router.get("/org-business-region", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE organization_id = $1 AND key = 'business_region'",
      [req.user.organizationId]
    );

    if (result.rows.length === 0) {
      // Self-heal: seed the default row for this org if somehow missing
      await pool.query(
        "INSERT INTO app_settings (organization_id, key, value) VALUES ($1, 'business_region', 'NZ') ON CONFLICT (organization_id, key) DO NOTHING",
        [req.user.organizationId]
      );
      return res.json({ countryCode: "NZ" });
    }

    res.json({ countryCode: result.rows[0].value });
  } catch (err) {
    console.error("[settings] GET /org-business-region:", err.message);
    res.status(500).json({ error: "Failed to fetch business region preference" });
  }
});

// ── PUT /api/settings/org-business-region ────────────────────────────────────
// Body: { countryCode: "AU" } — saved against the caller's organization
router.put("/org-business-region", async (req, res) => {
  const { countryCode } = req.body;

  if (!countryCode || typeof countryCode !== "string" || !countryCode.trim()) {
    return res.status(400).json({ error: "countryCode is required" });
  }

  const trimmed = countryCode.trim().toUpperCase();

  try {
    // Validate the code exists in the business_regions table
    const check = await pool.query(
      "SELECT country_code FROM business_regions WHERE country_code = $1",
      [trimmed]
    );

    if (check.rows.length === 0) {
      return res.status(400).json({ error: `Unknown country code: ${trimmed}` });
    }

    // Upsert into app_settings, scoped to this organization
    await pool.query(
      `INSERT INTO app_settings (organization_id, key, value, updated_at)
       VALUES ($1, 'business_region', $2, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE
         SET value      = EXCLUDED.value,
             updated_at = NOW()`,
      [req.user.organizationId, trimmed]
    );

    res.json({ countryCode: trimmed });
  } catch (err) {
    console.error("[settings] PUT /org-business-region:", err.message);
    res.status(500).json({ error: "Failed to save business region preference" });
  }
});

module.exports = router;

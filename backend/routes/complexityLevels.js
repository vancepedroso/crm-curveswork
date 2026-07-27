/**
 * routes/complexityLevels.js
 *
 * Job Complexity multipliers (Low/Medium/High/Complex/Very Complex), stored
 * as a JSON array under the 'job_complexity_levels' key in the existing
 * app_settings table, scoped per organization — same key/value mechanism the
 * currency preference uses. One GET (read the list) + one PUT (replace the
 * whole list) since the Settings page edits/adds/removes rows in one form
 * and saves them all at once, rather than per-row endpoints.
 *
 * Mount point (in server.js): app.use("/api/complexity-levels", router)
 */
const { Router } = require("express");
const pool   = require("../db");
const router = Router();

const SETTINGS_KEY = "job_complexity_levels";

// Seeded for a brand-new organization on first access, so its Job
// Complexity selector isn't empty before anyone's had a chance to visit the
// settings page — same defaults every org started with historically.
const DEFAULT_LEVELS = [
  { key: "low",          label: "Low",          factor: 1.0,  desc: "Simple gable/mono roof, easy access" },
  { key: "medium",       label: "Medium",       factor: 1.15, desc: "Standard hip roof, normal access" },
  { key: "high",         label: "High",         factor: 1.3,  desc: "Multiple planes, steep pitch or restricted access" },
  { key: "complex",      label: "Complex",      factor: 1.5,  desc: "Heavy cutting, valleys/dormers, height/safety gear" },
  { key: "very_complex", label: "Very Complex", factor: 1.75, desc: "Highly irregular roof, difficult access, specialist crew" },
];

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE organization_id = $1 AND key = $2",
      [req.user.organizationId, SETTINGS_KEY]
    );
    if (rows.length) return res.json(JSON.parse(rows[0].value));

    await pool.query(
      `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [req.user.organizationId, SETTINGS_KEY, JSON.stringify(DEFAULT_LEVELS)]
    );
    res.json(DEFAULT_LEVELS);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/", async (req, res) => {
  try {
    const levels = req.body;
    if (!Array.isArray(levels) || !levels.length) {
      return res.status(400).json({ error: "Expected a non-empty array of complexity levels" });
    }
    const keys = new Set();
    for (const l of levels) {
      if (!l.key || !l.label || typeof l.factor !== "number" || l.factor <= 0) {
        return res.status(400).json({ error: "Each level needs a key, label, and a positive numeric factor" });
      }
      if (keys.has(l.key)) return res.status(400).json({ error: `Duplicate key: ${l.key}` });
      keys.add(l.key);
    }
    await pool.query(
      `INSERT INTO app_settings (organization_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.user.organizationId, SETTINGS_KEY, JSON.stringify(levels)]
    );
    res.json(levels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

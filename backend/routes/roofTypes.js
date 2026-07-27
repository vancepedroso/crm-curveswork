const { Router } = require("express");
const pool = require("../db");
const router = Router();

// GET all active roof types, scoped to the caller's organization. Note: the
// frontend doesn't currently call this endpoint at all (the "Roof Type"
// dropdown uses a hardcoded list in src/App.jsx instead) — scoped here for
// consistency/safety anyway, but a brand-new org will see an empty list
// since nothing seeds roof_types per-org the way roof_materials does.
router.get("/", async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, label, rate_per_sqm, is_active FROM roof_types WHERE is_active = true AND organization_id = $1 ORDER BY label",
            [req.user.organizationId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch roof types" });
    }
});

module.exports = router;
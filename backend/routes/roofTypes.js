const { Router } = require("express");
const pool = require("../db");
const router = Router();

// GET all active roof types
router.get("/", async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, label, rate_per_sqm, is_active FROM roof_types WHERE is_active = true ORDER BY label"
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch roof types" });
    }
});

module.exports = router;
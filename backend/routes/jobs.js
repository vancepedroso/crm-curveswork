const { Router } = require("express");
const pool   = require("../db");
const router = Router();

function serializeJob(row) {
  return {
    id:         row.id,
    customerId: row.customer_id,
    jobNumber:  row.job_number,
    notes:      row.notes || "",
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
  };
}

// GET all (optionally filtered by ?customerId=) — scoped to caller's org
router.get("/", async (req, res) => {
  try {
    const { customerId } = req.query;
    const { rows } = customerId
      ? await pool.query("SELECT * FROM jobs WHERE customer_id = $1 AND organization_id = $2 ORDER BY created_at DESC", [customerId, req.user.organizationId])
      : await pool.query("SELECT * FROM jobs WHERE organization_id = $1 ORDER BY created_at DESC", [req.user.organizationId]);
    res.json(rows.map(serializeJob));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET one
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM jobs WHERE id = $1 AND organization_id = $2", [req.params.id, req.user.organizationId]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(serializeJob(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create — organization_id always from the token; customerId must
// belong to that same organization
router.post("/", async (req, res) => {
  try {
    const { customerId, jobNumber, notes } = req.body;
    if (!customerId || !jobNumber || !jobNumber.trim()) {
      return res.status(400).json({ error: "customerId and jobNumber are required" });
    }
    const { rows: [customer] } = await pool.query(
      "SELECT id FROM customers WHERE id = $1 AND organization_id = $2", [customerId, req.user.organizationId]
    );
    if (!customer) return res.status(400).json({ error: "customerId not found in your organization" });

    const { rows } = await pool.query(
      `INSERT INTO jobs (customer_id, job_number, notes, organization_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [customerId, jobNumber, notes || null, req.user.organizationId]
    );
    res.status(201).json(serializeJob(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update
router.put("/:id", async (req, res) => {
  try {
    const { jobNumber, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE jobs SET job_number=$1, notes=$2 WHERE id=$3 AND organization_id=$4 RETURNING *`,
      [jobNumber, notes || null, req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(serializeJob(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM jobs WHERE id = $1 AND organization_id = $2", [req.params.id, req.user.organizationId]);
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

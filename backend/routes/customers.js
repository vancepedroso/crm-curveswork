const { Router } = require("express");
const pool   = require("../db");
const router = Router();

// GET all — scoped to the caller's own organization
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE organization_id = $1 ORDER BY name",
      [req.user.organizationId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET one
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE id = $1 AND organization_id = $2",
      [req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create — organization_id always comes from the token, never the body
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO customers (name, email, phone, address, organization_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, email, phone, address, req.user.organizationId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update
router.put("/:id", async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;
    const { rows } = await pool.query(
      `UPDATE customers SET name=$1, email=$2, phone=$3, address=$4
       WHERE id=$5 AND organization_id=$6 RETURNING *`,
      [name, email, phone, address, req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM customers WHERE id = $1 AND organization_id = $2",
      [req.params.id, req.user.organizationId]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

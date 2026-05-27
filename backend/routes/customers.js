const { Router } = require("express");
const pool   = require("../db");
const router = Router();

// GET all
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM customers ORDER BY name"
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
      "SELECT * FROM customers WHERE id = $1", [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO customers (name, email, phone, address)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, email, phone, address]
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
       WHERE id=$5 RETURNING *`,
      [name, email, phone, address, req.params.id]
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
      "DELETE FROM customers WHERE id = $1", [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
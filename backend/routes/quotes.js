const { Router } = require("express");
const pool   = require("../db");
const router = Router();

function serializeQuote(row) {
  return {
    id:        row.id,
    projectId: row.project_id,
    quoteNum:  row.quote_num,
    quoteDate: row.quote_date,
    total:     parseFloat(row.total) || 0,
    snapshot:  row.snapshot,
    createdAt: row.created_at,
  };
}

// GET /api/quotes/:projectId — quote history for a project, newest first
router.get("/:projectId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM quotes WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.projectId]
    );
    res.json(rows.map(serializeQuote));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quotes/:projectId — persist a quote snapshot (called when a quote is sent)
router.post("/:projectId", async (req, res) => {
  try {
    const { quoteNum, quoteDate, total, snapshot } = req.body;
    if (!quoteNum || !quoteDate) {
      return res.status(400).json({ error: "quoteNum and quoteDate are required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO quotes (project_id, quote_num, quote_date, total, snapshot)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.projectId, quoteNum, quoteDate, total || 0, JSON.stringify(snapshot || {})]
    );
    res.status(201).json(serializeQuote(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

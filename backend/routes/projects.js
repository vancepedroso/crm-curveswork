const { Router } = require("express");
const pool   = require("../db");
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shared serialiser — used by every route so the shape is always identical.
// Keeps snake_case DB columns out of the API contract entirely.
// ─────────────────────────────────────────────────────────────────────────────
function serializeProject(row) {
  return {
    id:         row.id,
    customerId: row.customer_id,
    address:    row.address,
    status:     row.status,
    area:       parseFloat(row.area)       || 0,
    roofType:   row.roof_type              || "",
    notes:      row.notes                  || "",
    quoteNum:   row.quote_num              || "",
    quoteDate:  row.quote_date             || "",
    createdAt:  row.created_at
      ? new Date(row.created_at).toISOString().slice(0, 10)
      : "",

    estimate: row.estimate_id ? {
      area:          parseFloat(row.est_area)      || 0,
      pitch:         parseFloat(row.pitch)         || 1.15,
      waste:         parseFloat(row.waste)         || 10,
      materialRate:  parseFloat(row.material_rate) || 55,
      materialLabel: row.material_label            || "",
      flashings:     parseFloat(row.flashings)     || 0,
      guttering:     parseFloat(row.guttering)     || 0,
      dayRate:       parseFloat(row.day_rate)      || 850,
      days:          parseFloat(row.days)          || 0,
      margin:        parseFloat(row.margin)        || 20,
      adjArea:       parseFloat(row.adj_area)      || 0,
      matCost:       parseFloat(row.mat_cost)      || 0,
      flashCost:     parseFloat(row.flash_cost)    || 0,
      gutCost:       parseFloat(row.gut_cost)      || 0,
      labCost:       parseFloat(row.lab_cost)      || 0,
      marginAmt:     parseFloat(row.margin_amt)    || 0,
      sellPrice:     parseFloat(row.sell_price)    || 0,
      gst:           parseFloat(row.gst)           || 0,
      total:         parseFloat(row.total)         || 0,
    } : null,

    // Embedded customer — handy for single-record lookups without a second query
    customer: row.customer_id ? {
      id:      row.customer_id,
      name:    row.customer_name    || "",
      email:   row.customer_email   || "",
      phone:   row.customer_phone   || "",
      address: row.customer_address || "",
    } : null,
  };
}

// Reusable joined SELECT fragment
const PROJECT_SELECT = `
  SELECT p.*,
         e.id            AS estimate_id,
         e.area          AS est_area,
         e.pitch, e.waste,
         e.material_rate, e.material_label,
         e.flashings, e.guttering,
         e.day_rate, e.days, e.margin,
         e.adj_area, e.mat_cost, e.flash_cost, e.gut_cost, e.lab_cost,
         e.margin_amt, e.sell_price, e.gst, e.total,
         c.name    AS customer_name,
         c.email   AS customer_email,
         c.phone   AS customer_phone,
         c.address AS customer_address
  FROM projects p
  LEFT JOIN estimates e ON e.project_id = p.id
  LEFT JOIN customers c ON c.id = p.customer_id
`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /projects
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(PROJECT_SELECT + "ORDER BY p.created_at DESC");
    res.json(rows.map(serializeProject));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /projects/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      PROJECT_SELECT + "WHERE p.id = $1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(serializeProject(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /projects  — create project (+ optional estimate in one transaction)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      customerId, address, status, area, roofType,
      notes, quoteNum, quoteDate, createdAt, estimate,
    } = req.body;

    if (!customerId || !address) {
      return res.status(400).json({ error: "customerId and address are required" });
    }

    const { rows: [project] } = await client.query(
      `INSERT INTO projects
         (customer_id, address, status, area, roof_type, notes,
          quote_num, quote_date, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        customerId, address, status || "New Lead", area || 0,
        roofType || "", notes || "",
        quoteNum  || null,
        quoteDate || null,
        createdAt || new Date().toISOString().slice(0, 10),
      ]
    );

    if (estimate?.total) {
      await client.query(
        `INSERT INTO estimates
           (project_id, area, pitch, waste, material_rate, material_label,
            flashings, guttering, day_rate, days, margin,
            adj_area, mat_cost, flash_cost, gut_cost, lab_cost,
            margin_amt, sell_price, gst, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          project.id, estimate.area, estimate.pitch, estimate.waste,
          estimate.materialRate, estimate.materialLabel,
          estimate.flashings, estimate.guttering,
          estimate.dayRate, estimate.days, estimate.margin,
          estimate.adjArea, estimate.matCost, estimate.flashCost,
          estimate.gutCost, estimate.labCost,
          estimate.marginAmt, estimate.sellPrice, estimate.gst, estimate.total,
        ]
      );
    }

    await client.query("COMMIT");

    // Return the full serialised shape (re-query to get joined data)
    const { rows } = await pool.query(
      PROJECT_SELECT + "WHERE p.id = $1", [project.id]
    );
    res.status(201).json(serializeProject(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /projects/:id  — full update (+ upsert estimate)
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      customerId, address, status, area,
      roofType, notes, quoteNum, quoteDate, estimate,
    } = req.body;

    const { rows: [project] } = await client.query(
      `UPDATE projects
         SET customer_id=$1, address=$2, status=$3, area=$4,
             roof_type=$5, notes=$6, quote_num=$7, quote_date=$8
       WHERE id=$9
       RETURNING *`,
      [
        customerId, address, status, area || 0,
        roofType || "", notes || "",
        quoteNum  || null,
        quoteDate || null,
        req.params.id,
      ]
    );

    if (!project) return res.status(404).json({ error: "Not found" });

    if (estimate?.total) {
      await client.query(
        `INSERT INTO estimates
           (project_id, area, pitch, waste, material_rate, material_label,
            flashings, guttering, day_rate, days, margin,
            adj_area, mat_cost, flash_cost, gut_cost, lab_cost,
            margin_amt, sell_price, gst, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (project_id) DO UPDATE SET
           area=EXCLUDED.area, pitch=EXCLUDED.pitch, waste=EXCLUDED.waste,
           material_rate=EXCLUDED.material_rate, material_label=EXCLUDED.material_label,
           flashings=EXCLUDED.flashings, guttering=EXCLUDED.guttering,
           day_rate=EXCLUDED.day_rate, days=EXCLUDED.days, margin=EXCLUDED.margin,
           adj_area=EXCLUDED.adj_area, mat_cost=EXCLUDED.mat_cost,
           flash_cost=EXCLUDED.flash_cost, gut_cost=EXCLUDED.gut_cost,
           lab_cost=EXCLUDED.lab_cost, margin_amt=EXCLUDED.margin_amt,
           sell_price=EXCLUDED.sell_price, gst=EXCLUDED.gst, total=EXCLUDED.total`,
        [
          req.params.id, estimate.area, estimate.pitch, estimate.waste,
          estimate.materialRate, estimate.materialLabel,
          estimate.flashings, estimate.guttering,
          estimate.dayRate, estimate.days, estimate.margin,
          estimate.adjArea, estimate.matCost, estimate.flashCost,
          estimate.gutCost, estimate.labCost,
          estimate.marginAmt, estimate.sellPrice, estimate.gst, estimate.total,
        ]
      );
    }

    await client.query("COMMIT");

    // Return the full serialised shape
    const { rows } = await pool.query(
      PROJECT_SELECT + "WHERE p.id = $1", [project.id]
    );
    res.json(serializeProject(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /projects/:id/status  — lightweight status-only update
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status is required" });

    const { rows } = await pool.query(
      "UPDATE projects SET status=$1 WHERE id=$2 RETURNING id, status",
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    // Return only what changed — no need for the full JOIN here
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /projects/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM projects WHERE id = $1", [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
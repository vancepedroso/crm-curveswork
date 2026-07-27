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
    jobId:      row.job_id,
    address:    row.address,
    status:     row.status,
    area:       parseFloat(row.area)       || 0,
    roofType:   row.roof_type              || "",
    notes:      row.notes                  || "",
    quoteNum:   row.quote_num              || "",
    quoteDate:  row.quote_date             || "",
    isDeleted:  row.is_deleted             || false,
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
      downpipes:     parseInt(row.downpipes, 10)   || 0,
      drains:        parseInt(row.drains, 10)      || 0,
      penetrations:  parseInt(row.penetrations, 10)|| 0,
      dayRate:       parseFloat(row.day_rate)      || 850,
      days:          parseFloat(row.days)          || 0,
      margin:        parseFloat(row.margin)        || 20,
      complexity:    row.complexity                || "medium",
      flashingRuns:  row.flashing_runs             || [],
      adjArea:       parseFloat(row.adj_area)      || 0,
      matCost:       parseFloat(row.mat_cost)      || 0,
      flashCost:     parseFloat(row.flash_cost)    || 0,
      gutCost:       parseFloat(row.gut_cost)      || 0,
      downpipeCost:  parseFloat(row.downpipe_cost)    || 0,
      drainCost:     parseFloat(row.drain_cost)       || 0,
      penetrationCost: parseFloat(row.penetration_cost) || 0,
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
         e.flashings, e.guttering, e.downpipes, e.drains, e.penetrations,
         e.day_rate, e.days, e.margin, e.complexity, e.flashing_runs,
         e.adj_area, e.mat_cost, e.flash_cost, e.gut_cost,
         e.downpipe_cost, e.drain_cost, e.penetration_cost, e.lab_cost,
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
// GET /projects — scoped to the caller's own organization
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      PROJECT_SELECT + "WHERE p.is_deleted = FALSE AND p.organization_id = $1 ORDER BY p.created_at DESC",
      [req.user.organizationId]
    );
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
      PROJECT_SELECT + "WHERE p.id = $1 AND p.organization_id = $2",
      [req.params.id, req.user.organizationId]
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
      customerId, jobId, address, status, area, roofType,
      notes, quoteNum, quoteDate, createdAt, estimate,
    } = req.body;

    if (!customerId || !address) {
      return res.status(400).json({ error: "customerId and address are required" });
    }

    // Never trust a client-supplied org id — and never let a project attach
    // to a customer/job that belongs to a different organization.
    const { rows: [customer] } = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND organization_id = $2", [customerId, req.user.organizationId]
    );
    if (!customer) return res.status(400).json({ error: "customerId not found in your organization" });
    if (jobId) {
      const { rows: [job] } = await client.query(
        "SELECT id FROM jobs WHERE id = $1 AND organization_id = $2", [jobId, req.user.organizationId]
      );
      if (!job) return res.status(400).json({ error: "jobId not found in your organization" });
    }

    const { rows: [project] } = await client.query(
      `INSERT INTO projects
         (customer_id, job_id, address, status, area, roof_type, notes,
          quote_num, quote_date, created_at, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        customerId, jobId || null, address, status || "New Lead", area || 0,
        roofType || "", notes || "",
        quoteNum  || null,
        quoteDate || null,
        createdAt || new Date().toISOString().slice(0, 10),
        req.user.organizationId,
      ]
    );

    if (estimate?.total) {
      await client.query(
        `INSERT INTO estimates
           (project_id, area, pitch, waste, material_rate, material_label,
            flashings, guttering, downpipes, drains, penetrations,
            day_rate, days, margin, complexity, flashing_runs,
            adj_area, mat_cost, flash_cost, gut_cost, downpipe_cost, drain_cost, penetration_cost, lab_cost,
            margin_amt, sell_price, gst, total, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [
          project.id, estimate.area, estimate.pitch, estimate.waste,
          estimate.materialRate, estimate.materialLabel,
          estimate.flashings, estimate.guttering,
          estimate.downpipes || 0, estimate.drains || 0, estimate.penetrations || 0,
          estimate.dayRate, estimate.days, estimate.margin, estimate.complexity || "medium",
          JSON.stringify(estimate.flashingRuns || []),
          estimate.adjArea, estimate.matCost, estimate.flashCost,
          estimate.gutCost, estimate.downpipeCost || 0, estimate.drainCost || 0, estimate.penetrationCost || 0, estimate.labCost,
          estimate.marginAmt, estimate.sellPrice, estimate.gst, estimate.total,
          req.user.organizationId,
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
      customerId, jobId, address, status, area,
      roofType, notes, quoteNum, quoteDate, estimate,
    } = req.body;

    const { rows: [customer] } = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND organization_id = $2", [customerId, req.user.organizationId]
    );
    if (!customer) return res.status(400).json({ error: "customerId not found in your organization" });
    if (jobId) {
      const { rows: [job] } = await client.query(
        "SELECT id FROM jobs WHERE id = $1 AND organization_id = $2", [jobId, req.user.organizationId]
      );
      if (!job) return res.status(400).json({ error: "jobId not found in your organization" });
    }

    const { rows: [project] } = await client.query(
      `UPDATE projects
         SET customer_id=$1, job_id=$2, address=$3, status=$4, area=$5,
             roof_type=$6, notes=$7, quote_num=$8, quote_date=$9
       WHERE id=$10 AND organization_id=$11
       RETURNING *`,
      [
        customerId, jobId || null, address, status, area || 0,
        roofType || "", notes || "",
        quoteNum  || null,
        quoteDate || null,
        req.params.id,
        req.user.organizationId,
      ]
    );

    if (!project) return res.status(404).json({ error: "Not found" });

    if (estimate?.total) {
      await client.query(
        `INSERT INTO estimates
           (project_id, area, pitch, waste, material_rate, material_label,
            flashings, guttering, downpipes, drains, penetrations,
            day_rate, days, margin, complexity, flashing_runs,
            adj_area, mat_cost, flash_cost, gut_cost, downpipe_cost, drain_cost, penetration_cost, lab_cost,
            margin_amt, sell_price, gst, total, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         ON CONFLICT (project_id) DO UPDATE SET
           area=EXCLUDED.area, pitch=EXCLUDED.pitch, waste=EXCLUDED.waste,
           material_rate=EXCLUDED.material_rate, material_label=EXCLUDED.material_label,
           flashings=EXCLUDED.flashings, guttering=EXCLUDED.guttering,
           downpipes=EXCLUDED.downpipes, drains=EXCLUDED.drains, penetrations=EXCLUDED.penetrations,
           day_rate=EXCLUDED.day_rate, days=EXCLUDED.days, margin=EXCLUDED.margin,
           complexity=EXCLUDED.complexity, flashing_runs=EXCLUDED.flashing_runs,
           adj_area=EXCLUDED.adj_area, mat_cost=EXCLUDED.mat_cost,
           flash_cost=EXCLUDED.flash_cost, gut_cost=EXCLUDED.gut_cost,
           downpipe_cost=EXCLUDED.downpipe_cost, drain_cost=EXCLUDED.drain_cost,
           penetration_cost=EXCLUDED.penetration_cost,
           lab_cost=EXCLUDED.lab_cost, margin_amt=EXCLUDED.margin_amt,
           sell_price=EXCLUDED.sell_price, gst=EXCLUDED.gst, total=EXCLUDED.total`,
        [
          req.params.id, estimate.area, estimate.pitch, estimate.waste,
          estimate.materialRate, estimate.materialLabel,
          estimate.flashings, estimate.guttering,
          estimate.downpipes || 0, estimate.drains || 0, estimate.penetrations || 0,
          estimate.dayRate, estimate.days, estimate.margin, estimate.complexity || "medium",
          JSON.stringify(estimate.flashingRuns || []),
          estimate.adjArea, estimate.matCost, estimate.flashCost,
          estimate.gutCost, estimate.downpipeCost || 0, estimate.drainCost || 0, estimate.penetrationCost || 0, estimate.labCost,
          estimate.marginAmt, estimate.sellPrice, estimate.gst, estimate.total,
          req.user.organizationId,
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
      "UPDATE projects SET status=$1 WHERE id=$2 AND organization_id=$3 RETURNING id, status",
      [status, req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    // Return only what changed — no need for the full JOIN here
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /projects/:id — soft delete (flags is_deleted, keeps the row so
// estimates/quotes/geometry history tied to it aren't lost)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE projects SET is_deleted = TRUE WHERE id = $1 AND organization_id = $2",
      [req.params.id, req.user.organizationId]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const { Router } = require("express");
const pool   = require("../db");
const router = Router();

router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Truncate existing
    await client.query("DELETE FROM project_geometries");
    await client.query("DELETE FROM estimates");
    await client.query("DELETE FROM projects");
    await client.query("DELETE FROM customers");

    const { customers, projects } = req.body;

    // Insert customers
    for (const c of (customers || [])) {
      await client.query(
        "INSERT INTO customers (id, name, email, phone, address) VALUES ($1,$2,$3,$4,$5)",
        [c.id, c.name, c.email, c.phone, c.address]
      );
    }

    // Insert projects with estimates
    for (const p of (projects || [])) {
      await client.query(
        `INSERT INTO projects (id, customer_id, address, status, area, roof_type,
           notes, quote_num, quote_date, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.id, p.customerId, p.address, p.status, p.area || 0,
         p.roofType || "", p.notes || "", p.quoteNum || null,
         p.quoteDate || null, p.createdAt || new Date().toISOString().slice(0,10)]
      );

      if (p.estimate && p.estimate.total) {
        const e = p.estimate;
        await client.query(
          `INSERT INTO estimates (project_id, area, pitch, waste, material_rate,
             material_label, flashings, guttering, day_rate, days, margin,
             adj_area, mat_cost, flash_cost, gut_cost, lab_cost,
             margin_amt, sell_price, gst, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [p.id, e.area, e.pitch, e.waste, e.materialRate, e.materialLabel,
           e.flashings, e.guttering, e.dayRate, e.days, e.margin,
           e.adjArea, e.matCost, e.flashCost, e.gutCost, e.labCost,
           e.marginAmt, e.sellPrice, e.gst, e.total]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, customers, projects });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
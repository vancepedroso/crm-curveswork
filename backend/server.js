const express = require("express");
const cors = require("cors");
require("dotenv").config();

const customersRouter = require("./routes/customers");
const projectsRouter  = require("./routes/projects");
const estimatesRouter = require("./routes/estimates");
const seedRouter      = require("./routes/seed");
const authRouter = require("./routes/auth");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use("/api/auth", authRouter);

// ── Routes ──
app.use("/api/customers",  customersRouter);
app.use("/api/projects",   projectsRouter);
app.use("/api/estimates",  estimatesRouter);
app.use("/api/seed",       seedRouter);

// ── Dashboard stats ──
app.get("/api/dashboard", async (req, res) => {
  try {
    const pool = require("./db");
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'New Lead')   AS leads,
        COUNT(*) FILTER (WHERE status = 'Quote Sent') AS sent,
        COUNT(*) FILTER (WHERE status = 'Won')        AS won,
        COUNT(*)                                      AS total,
        COALESCE(SUM(e.total) FILTER (WHERE p.status = 'Won'), 0)        AS revenue,
        COALESCE(SUM(e.total) FILTER (WHERE p.status = 'Quote Sent'), 0) AS pipeline_value
      FROM projects p
      LEFT JOIN estimates e ON e.project_id = p.id
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard query failed" });
  }
});

// ── Pipeline by status ──
app.get("/api/pipeline", async (req, res) => {
  try {
    const pool = require("./db");
    const result = await pool.query(`
      SELECT p.*, e.total as estimate_total,
             c.name as customer_name
      FROM projects p
      LEFT JOIN estimates e ON e.project_id = p.id
      LEFT JOIN customers c ON c.id = p.customer_id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline query failed" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
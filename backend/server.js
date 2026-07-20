const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const https   = require("https");
require("dotenv").config();

const customersRouter = require("./routes/customers");
const projectsRouter  = require("./routes/projects");
const estimatesRouter = require("./routes/estimates");
const seedRouter      = require("./routes/seed");
const authRouter      = require("./routes/auth");
const usersRouter     = require("./routes/users");
const settingsRouter = require("./routes/settings");
const roofTypesRouter = require("./routes/roofTypes");
const photosRouter     = require("./routes/photos");
const quotesRouter     = require("./routes/quotes");
const jobsRouter       = require("./routes/jobs");
const jobPhotosRouter  = require("./routes/jobPhotos");
const materialsRouter  = require("./routes/materials");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Auth (no JWT required) ──
app.use("/api/auth", authRouter);

// ── Protected routes ──
// users.js has requireAuth built into every handler, so no middleware needed here
app.use("/api/customers", customersRouter);
app.use("/api/projects",  projectsRouter);
app.use("/api/estimates", estimatesRouter);
app.use("/api/seed",      seedRouter);
app.use("/api/users",     usersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/roof-types", roofTypesRouter);
app.use("/api/photos",    photosRouter);
app.use("/api/quotes",    quotesRouter);
app.use("/api/jobs",       jobsRouter);
app.use("/api/job-photos", jobPhotosRouter);
app.use("/api/materials",  materialsRouter);

// ── Dashboard stats ──
app.get("/api/dashboard", async (req, res) => {
  try {
    const pool  = require("./db");
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'New Lead')   AS leads,
        COUNT(*) FILTER (WHERE status = 'Quote Sent') AS sent,
        COUNT(*) FILTER (WHERE status = 'Won')        AS won,
        COUNT(*)                                      AS total,
        COALESCE(SUM(e.total) FILTER (WHERE p.status = 'Won'),        0) AS revenue,
        COALESCE(SUM(e.total) FILTER (WHERE p.status = 'Quote Sent'), 0) AS pipeline_value
      FROM projects p
      LEFT JOIN estimates e ON e.project_id = p.id
      WHERE p.is_deleted = FALSE
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
    const pool   = require("./db");
    const result = await pool.query(`
      SELECT p.*, e.total AS estimate_total,
             c.name AS customer_name
      FROM projects p
      LEFT JOIN estimates e ON e.project_id = p.id
      LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.is_deleted = FALSE
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline query failed" });
  }
});

// Shared self-signed cert (../certs/) also used by the Vite dev server —
// HTTPS is required here too, since a page served over HTTPS can't call an
// HTTP API without the browser blocking it as mixed content.
const certDir = path.join(__dirname, "..", "certs");
const httpsOptions = {
  key:  fs.readFileSync(path.join(certDir, "key.pem")),
  cert: fs.readFileSync(path.join(certDir, "cert.pem")),
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`✅ Backend running on https://localhost:${PORT}`);
});
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const https   = require("https");
require("dotenv").config();

const { requireAuth, requirePlatformAdmin } = require("./middleware/auth");
const customersRouter = require("./routes/customers");
const projectsRouter  = require("./routes/projects");
const estimatesRouter = require("./routes/estimates");
const authRouter      = require("./routes/auth");
const usersRouter     = require("./routes/users");
const settingsRouter = require("./routes/settings");
const roofTypesRouter = require("./routes/roofTypes");
const photosRouter     = require("./routes/photos");
const quotesRouter     = require("./routes/quotes");
const jobsRouter       = require("./routes/jobs");
const jobPhotosRouter  = require("./routes/jobPhotos");
const materialsRouter  = require("./routes/materials");
const companyProfileRouter = require("./routes/companyProfile");
const complexityLevelsRouter = require("./routes/complexityLevels");
const billingRouter = require("./routes/billing");
const stripeWebhookRouter = require("./routes/stripeWebhook");
const organizationRouter = require("./routes/organization");
const platformAdminRouter = require("./routes/platformAdmin");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// Stripe webhook needs the RAW request body for signature verification, so
// it's mounted before express.json() parses everything else into an object.
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookRouter);

app.use(express.json({ limit: "5mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Auth (no JWT required — this is how you get one) ──
app.use("/api/auth", authRouter);

// ── Billing (public signup + owner-only portal link) ──
app.use("/api/billing", billingRouter);

// ── Protected routes ──
// requireAuth applied uniformly here rather than inside each router, so
// there's one place that shows every route in the app that requires a
// logged-in (and now, org-scoped) user — previously customers/projects/
// estimates/jobs/photos/quotes/jobPhotos/materials/roofTypes/settings/
// complexityLevels had NO auth at all; users.js/companyProfile.js each had
// their own duplicated inline copy. Both problems are fixed by mounting
// the one shared middleware here.
app.use("/api/customers", requireAuth, customersRouter);
app.use("/api/projects",  requireAuth, projectsRouter);
app.use("/api/estimates", requireAuth, estimatesRouter);
app.use("/api/users",     requireAuth, usersRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/roof-types", requireAuth, roofTypesRouter);
app.use("/api/photos",    requireAuth, photosRouter);
app.use("/api/quotes",    requireAuth, quotesRouter);
app.use("/api/jobs",       requireAuth, jobsRouter);
app.use("/api/job-photos", requireAuth, jobPhotosRouter);
app.use("/api/materials",  requireAuth, materialsRouter);
app.use("/api/company-profile", requireAuth, companyProfileRouter);
app.use("/api/complexity-levels", requireAuth, complexityLevelsRouter);
app.use("/api/organization", requireAuth, organizationRouter);
app.use("/api/platform-admin", requireAuth, requirePlatformAdmin, platformAdminRouter);

// ── Dashboard stats ──
app.get("/api/dashboard", requireAuth, async (req, res) => {
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
      WHERE p.is_deleted = FALSE AND p.organization_id = $1
    `, [req.user.organizationId]);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard query failed" });
  }
});

// ── Pipeline by status ──
app.get("/api/pipeline", requireAuth, async (req, res) => {
  try {
    const pool   = require("./db");
    const result = await pool.query(`
      SELECT p.*, e.total AS estimate_total,
             c.name AS customer_name
      FROM projects p
      LEFT JOIN estimates e ON e.project_id = p.id
      LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.is_deleted = FALSE AND p.organization_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.organizationId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline query failed" });
  }
});

// ── Listener ──────────────────────────────────────────────────────────
// Locally this serves HTTPS from the shared self-signed cert in ../certs/
// (also used by the Vite dev server): a page served over HTTPS can't call
// an HTTP API without the browser blocking it as mixed content, and the
// LiveCamera tool needs a secure context for getUserMedia when opened on a
// phone over the LAN — which is what the SANs in certs/san.cnf are for.
//
// A managed host (Render, Railway, Fly…) terminates TLS at its edge and
// speaks plain HTTP to the process, so binding HTTPS there fails the health
// check and the service never goes live. Render sets RENDER=true; the cert
// check is a second guard so any environment without the .pem files still
// boots instead of throwing at startup.
const certDir = path.join(__dirname, "..", "certs");
const useHttps =
  !process.env.RENDER &&
  fs.existsSync(path.join(certDir, "key.pem")) &&
  fs.existsSync(path.join(certDir, "cert.pem"));

if (!useHttps) {
  app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT} (TLS terminated upstream)`);
  });
} else {
  const httpsOptions = {
    key:  fs.readFileSync(path.join(certDir, "key.pem")),
    cert: fs.readFileSync(path.join(certDir, "cert.pem")),
  };
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`✅ Backend running on https://localhost:${PORT}`);
  });
}
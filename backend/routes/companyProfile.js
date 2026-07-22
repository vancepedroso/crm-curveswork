const { Router } = require("express");
const multer = require("multer");
const path   = require("path");
const fs     = require("fs");
const jwt    = require("jsonwebtoken");
const pool   = require("../db");

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "changeme_use_env_in_prod";

// ── Auth middleware (same pattern as backend/routes/users.js) ──────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorised" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "branding");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.kind}-${req.user.id}-${Date.now()}${ext}`);
  },
});

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml"]);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(new Error("Unsupported image type"));
    cb(null, true);
  },
});

function serializeProfile(row) {
  return {
    companyName:    row.company_name    || "",
    companyAddress: row.company_address || "",
    companyPhone:   row.company_phone   || "",
    companyEmail:   row.company_email   || "",
    companyGst:     row.company_gst     || "",
    companyBank:    row.company_bank    || "",
    logoUrl:        row.logo_url        || "",
    badgesUrl:      row.badges_url      || "",
    estimatorName:  row.estimator_name  || "",
    estimatorTitle: row.estimator_title || "",
    dayRate:        parseFloat(row.day_rate) || 850,
    margin:         parseFloat(row.margin)   || 20,
    wastage:        parseFloat(row.wastage)  || 10,
  };
}

async function getOrCreateProfile(userId) {
  const { rows } = await pool.query("SELECT * FROM company_profiles WHERE user_id = $1", [userId]);
  if (rows.length) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO company_profiles (user_id) VALUES ($1) RETURNING *`,
    [userId]
  );
  return created[0];
}

// GET /api/company-profile — current user's branding, auto-created on first access
router.get("/", requireAuth, async (req, res) => {
  try {
    const row = await getOrCreateProfile(req.user.id);
    res.json(serializeProfile(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/company-profile — update text fields
router.put("/", requireAuth, async (req, res) => {
  try {
    await getOrCreateProfile(req.user.id); // ensure a row exists
    const {
      companyName, companyAddress, companyPhone, companyEmail,
      companyGst, companyBank, estimatorName, estimatorTitle,
      dayRate, margin, wastage,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE company_profiles SET
         company_name=$1, company_address=$2, company_phone=$3, company_email=$4,
         company_gst=$5, company_bank=$6, estimator_name=$7, estimator_title=$8,
         day_rate=$9, margin=$10, wastage=$11, updated_at=NOW()
       WHERE user_id=$12
       RETURNING *`,
      [
        companyName || "", companyAddress || "", companyPhone || "", companyEmail || "",
        companyGst || "", companyBank || "", estimatorName || "", estimatorTitle || "",
        dayRate || 850, margin || 20, wastage || 10,
        req.user.id,
      ]
    );
    res.json(serializeProfile(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/company-profile/logo | /badges — image upload (field "image")
router.post("/:kind(logo|badges)", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      await getOrCreateProfile(req.user.id);
      const url = `/uploads/branding/${req.file.filename}`;
      const column = req.params.kind === "logo" ? "logo_url" : "badges_url";
      const { rows } = await pool.query(
        `UPDATE company_profiles SET ${column} = $1, updated_at = NOW() WHERE user_id = $2 RETURNING *`,
        [url, req.user.id]
      );
      res.status(201).json(serializeProfile(rows[0]));
    } catch (dbErr) {
      res.status(500).json({ error: dbErr.message });
    }
  });
});

module.exports = router;

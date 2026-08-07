const { Router } = require("express");
const multer = require("multer");
const pool   = require("../db");
const { CLOUDINARY_CONFIGURED, FOLDERS, uploadBuffer } = require("../lib/cloudinaryStorage");

const router = Router();
// requireAuth is applied once, in server.js — no per-router copy needed here.

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml"]);

// ← memoryStorage, not diskStorage — see lib/cloudinaryStorage.js for why.
const upload = multer({
  storage: multer.memoryStorage(),
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
    discountEnabled: !!row.discount_enabled,
    discountType:    row.discount_type || "percent",
    discountValue:   parseFloat(row.discount_value) || 0,
    downpipeStockLengths: row.downpipe_stock_lengths || "1.8,2.4",
    downpipeBendRate: parseFloat(row.downpipe_bend_rate) || 15,
    spreaderRate:     parseFloat(row.spreader_rate)      || 45,
  };
}

async function getOrCreateProfile(organizationId) {
  const { rows } = await pool.query("SELECT * FROM company_profiles WHERE organization_id = $1", [organizationId]);
  if (rows.length) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO company_profiles (organization_id) VALUES ($1) RETURNING *`,
    [organizationId]
  );
  return created[0];
}

// GET /api/company-profile — the caller's organization's branding, shared by
// every user in it, auto-created on first access
router.get("/", async (req, res) => {
  try {
    const row = await getOrCreateProfile(req.user.organizationId);
    res.json(serializeProfile(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/company-profile — update text fields
router.put("/", async (req, res) => {
  try {
    await getOrCreateProfile(req.user.organizationId); // ensure a row exists
    const {
      companyName, companyAddress, companyPhone, companyEmail,
      companyGst, companyBank, estimatorName, estimatorTitle,
      dayRate, margin, wastage,
      discountEnabled, discountType, discountValue,
      downpipeStockLengths, downpipeBendRate, spreaderRate,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE company_profiles SET
         company_name=$1, company_address=$2, company_phone=$3, company_email=$4,
         company_gst=$5, company_bank=$6, estimator_name=$7, estimator_title=$8,
         day_rate=$9, margin=$10, wastage=$11,
         discount_enabled=$12, discount_type=$13, discount_value=$14,
         downpipe_stock_lengths=$15, downpipe_bend_rate=$16, spreader_rate=$17,
         updated_at=NOW()
       WHERE organization_id=$18
       RETURNING *`,
      [
        companyName || "", companyAddress || "", companyPhone || "", companyEmail || "",
        companyGst || "", companyBank || "", estimatorName || "", estimatorTitle || "",
        dayRate || 850, margin || 20, wastage || 10,
        discountEnabled || false, discountType || "percent", discountValue || 0,
        downpipeStockLengths || "1.8,2.4", downpipeBendRate || 15, spreaderRate || 45,
        req.user.organizationId,
      ]
    );
    res.json(serializeProfile(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/company-profile/logo | /badges — image upload (field "image")
router.post("/:kind(logo|badges)", (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!CLOUDINARY_CONFIGURED)
        return res.status(500).json({ error: "Image storage is not configured on the server" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      await getOrCreateProfile(req.user.organizationId);
      // ← Keyed by organizationId, not user id — the profile is shared by
      //   the whole org, so that's the collision to avoid (two users in the
      //   same org uploading a logo in the same millisecond).
      const publicId = `${req.params.kind}-${req.user.organizationId}-${Date.now()}`;
      const url = await uploadBuffer(req.file.buffer, FOLDERS.branding, publicId);
      const column = req.params.kind === "logo" ? "logo_url" : "badges_url";
      const { rows } = await pool.query(
        `UPDATE company_profiles SET ${column} = $1, updated_at = NOW() WHERE organization_id = $2 RETURNING *`,
        [url, req.user.organizationId]
      );
      res.status(201).json(serializeProfile(rows[0]));
    } catch (dbErr) {
      res.status(500).json({ error: dbErr.message });
    }
  });
});

module.exports = router;

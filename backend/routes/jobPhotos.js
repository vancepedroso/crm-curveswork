const { Router } = require("express");
const multer = require("multer");
const pool   = require("../db");
const { CLOUDINARY_CONFIGURED, FOLDERS, uploadBuffer, destroyByUrl } = require("../lib/cloudinaryStorage");

const router = Router();

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

// ← memoryStorage, not diskStorage — see lib/cloudinaryStorage.js for why.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(new Error("Unsupported image type"));
    cb(null, true);
  },
});

function serializePhoto(row) {
  return {
    id:        row.id,
    jobId:     row.job_id,
    url:       row.url,
    caption:   row.caption || "",
    createdAt: row.created_at,
  };
}

async function assertOwnJob(jobId, organizationId) {
  const { rows } = await pool.query(
    "SELECT id FROM jobs WHERE id = $1 AND organization_id = $2", [jobId, organizationId]
  );
  return rows.length > 0;
}

// GET /api/job-photos/:jobId — list photos for a job
router.get("/:jobId", async (req, res) => {
  try {
    if (!(await assertOwnJob(req.params.jobId, req.user.organizationId))) return res.json([]);
    const { rows } = await pool.query(
      "SELECT * FROM job_photos WHERE job_id = $1 AND organization_id = $2 ORDER BY created_at DESC",
      [req.params.jobId, req.user.organizationId]
    );
    res.json(rows.map(serializePhoto));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job-photos/:jobId — upload one or more photos (multipart/form-data, field "photos")
router.post("/:jobId", (req, res) => {
  upload.array("photos", 10)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!CLOUDINARY_CONFIGURED)
        return res.status(500).json({ error: "Image storage is not configured on the server" });
      if (!(await assertOwnJob(req.params.jobId, req.user.organizationId)))
        return res.status(404).json({ error: "Job not found" });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "No files uploaded" });

      const inserted = [];
      for (const file of files) {
        const publicId = `${req.params.jobId}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const url = await uploadBuffer(file.buffer, FOLDERS.jobPhotos, publicId);
        const { rows } = await pool.query(
          `INSERT INTO job_photos (job_id, filename, url, organization_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.params.jobId, publicId, url, req.user.organizationId]
        );
        inserted.push(serializePhoto(rows[0]));
      }
      res.status(201).json(inserted);
    } catch (dbErr) {
      res.status(500).json({ error: dbErr.message });
    }
  });
});

// DELETE /api/job-photos/:id — remove a photo record + file
router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM job_photos WHERE id = $1 AND organization_id = $2 RETURNING url",
      [req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    destroyByUrl(rows[0].url); // best-effort remote cleanup, never fails the delete

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

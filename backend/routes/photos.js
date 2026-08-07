const { Router } = require("express");
const multer = require("multer");
const pool   = require("../db");
const { CLOUDINARY_CONFIGURED, FOLDERS, uploadBuffer, destroyByUrl } = require("../lib/cloudinaryStorage");

const router = Router();

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

// ← memoryStorage, not diskStorage: the bytes go straight to Cloudinary
//   rather than to a local folder that a managed host wipes on restart.
//   Side benefit — a file rejected by the ownership check below no longer
//   leaves an orphan on disk, which the old disk-first flow always did.
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
    projectId: row.project_id,
    url:       row.url,
    caption:   row.caption || "",
    createdAt: row.created_at,
  };
}

async function assertOwnProject(projectId, organizationId) {
  const { rows } = await pool.query(
    "SELECT id FROM projects WHERE id = $1 AND organization_id = $2", [projectId, organizationId]
  );
  return rows.length > 0;
}

// GET /api/photos/:projectId — list photos for a project
router.get("/:projectId", async (req, res) => {
  try {
    if (!(await assertOwnProject(req.params.projectId, req.user.organizationId))) return res.json([]);
    const { rows } = await pool.query(
      "SELECT * FROM project_photos WHERE project_id = $1 AND organization_id = $2 ORDER BY created_at DESC",
      [req.params.projectId, req.user.organizationId]
    );
    res.json(rows.map(serializePhoto));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photos/:projectId — upload one or more photos (multipart/form-data, field "photos")
router.post("/:projectId", (req, res) => {
  upload.array("photos", 10)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!CLOUDINARY_CONFIGURED)
        return res.status(500).json({ error: "Image storage is not configured on the server" });
      if (!(await assertOwnProject(req.params.projectId, req.user.organizationId)))
        return res.status(404).json({ error: "Project not found" });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "No files uploaded" });

      const inserted = [];
      for (const file of files) {
        // Same shape as the old on-disk filename, minus the extension —
        // Cloudinary derives that itself and appends it to the URL.
        const publicId = `${req.params.projectId}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const url = await uploadBuffer(file.buffer, FOLDERS.photos, publicId);
        const { rows } = await pool.query(
          `INSERT INTO project_photos (project_id, filename, url, organization_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.params.projectId, publicId, url, req.user.organizationId]
        );
        inserted.push(serializePhoto(rows[0]));
      }
      res.status(201).json(inserted);
    } catch (dbErr) {
      res.status(500).json({ error: dbErr.message });
    }
  });
});

// DELETE /api/photos/:id — remove a photo record + file
router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM project_photos WHERE id = $1 AND organization_id = $2 RETURNING url",
      [req.params.id, req.user.organizationId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    // Best-effort remote cleanup, same intent as the old fs.unlink callback:
    // a failure here must not fail the delete, the DB row is already gone.
    destroyByUrl(rows[0].url);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

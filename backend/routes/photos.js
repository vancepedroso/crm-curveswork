const { Router } = require("express");
const multer = require("multer");
const path   = require("path");
const fs     = require("fs");
const pool   = require("../db");

const router = Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "photos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.projectId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

const upload = multer({
  storage,
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

// GET /api/photos/:projectId — list photos for a project
router.get("/:projectId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM project_photos WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.projectId]
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
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "No files uploaded" });

      const inserted = [];
      for (const file of files) {
        const url = `/uploads/photos/${file.filename}`;
        const { rows } = await pool.query(
          `INSERT INTO project_photos (project_id, filename, url) VALUES ($1,$2,$3) RETURNING *`,
          [req.params.projectId, file.filename, url]
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
      "DELETE FROM project_photos WHERE id = $1 RETURNING filename",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const filePath = path.join(UPLOAD_DIR, rows[0].filename);
    fs.unlink(filePath, () => {}); // best-effort cleanup, ignore missing file

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
